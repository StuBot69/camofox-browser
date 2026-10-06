// VERIFY the redirect finding independently, against the real plugin.
//
// Claim under test: a 307/308 redirect's second POST leaves the machine with NO
// context.route() handler invocation, so grantCovers() is never consulted for
// the hop that actually carries the body and the cookie.
//
// The brief's amendment said not to act on this unverified. It is now reported
// as reproduced, so the first thing to do is check it with this repo's own
// engine rather than take it on trust -- the extension probe passed on a
// browser with nothing loaded, so a claim from a probe is exactly the kind of
// claim that needs a second instrument.
//
// Run: CAMOUFOX_BIN=... node measure_redirect_gate.mjs

import http from 'node:http';
import { firefox } from 'playwright-core';
import { createApprovalSurface } from '../plugins/egress-gate/lib/approval.js';
import { createAuditLog } from '../plugins/egress-gate/lib/audit.js';
import { createEgressGate } from '../plugins/egress-gate/lib/gate.js';

const SEEN = [];

/**
 * Hop 1 answers 307 to /hop2; hop 2 is where the body and cookie land.
 *
 * `target` is the path the page's triggers actually POST to. It is a PARAMETER
 * because it used to be hardcoded to '/r307', which made cases C and D
 * vacuous: they registered a grant for a different URL ('/hop302', '/hop2')
 * than the one the button requested, so the gate found no matching grant, the
 * approval timed out unanswered, nothing landed, and "landed nothing" was
 * scored as safety. A gate that refused EVERYTHING scored identically.
 */
function startServer(target = '/r307') {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        SEEN.push({ method: req.method, path: req.url, body, cookie: req.headers.cookie ?? null });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          // The target is injected, so the grant a case registers and the URL
          // its trigger requests are the same string by construction. The
          // mismatch that made C and D meaningless is now unrepresentable.
          res.end(`<!doctype html><meta charset=utf-8><title>redirect probe</title>
<button id="jsfetch" onclick="fetch('${target}',{method:'POST',body:'card=4111111111111111',credentials:'include'})">Pay now</button>
<form method="post" action="${target}"><input name="card" value="4111111111111111"><button id="postform" type="submit">Pay by form</button></form>
`);
        } else if (req.url === '/r307') {
          // 307 preserves method AND body. 308 is the same for our purposes.
          // The status is RECORDED on the entry so a case can assert it really
          // issued the redirect it is named for, rather than inferring that
          // from the absence of a second hop.
          SEEN[SEEN.length - 1].redirectsTo = 307;
          res.writeHead(307, { Location: '/hop2' });
          res.end();
        } else if (req.url === '/r302') {
          // 302 downgrades POST to GET and drops the body -- the safe case.
          SEEN[SEEN.length - 1].redirectsTo = 302;
          res.writeHead(302, { Location: '/hop2' });
          res.end();
        } else if (req.url === '/direct') {
          // NO redirect. This is what makes case D an actual positive control:
          // an approved POST must arrive. Before this route existed D had no
          // non-redirecting path to exercise, so "must still land" could never
          // land and nothing noticed.
          SEEN[SEEN.length - 1].redirectsTo = null; // explicitly "no redirect"
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const CAMOUFOX_BIN =
  process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE || null;

/** Requests playwright reports, from OUTSIDE the route interception layer. */
async function observeViaEvents(page, context, seen) {
  const record = (r) => seen.push({ method: r.method(), url: r.url() });
  page.on('request', record);
  context.on('request', record);
}

async function run(label, { target, hop, trigger, grant, expect }) {
  const { srv, url } = await startServer(target);
  const browser = await firefox.launch({ headless: true, executablePath: CAMOUFOX_BIN });
  const context = await browser.newContext();
  const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 4000 });
  const audit = createAuditLog();
  const gate = createEgressGate({ approval, audit });

  // One approval granted up front for the FIRST hop only, which is exactly the
  // shape of the reported bypass: one human yes, then an unapproved second hop.
  //
  // `hop` MUST equal `target`. It is a separate parameter only so a case that
  // wires them differently is still expressible -- and the assertions below
  // then fail loudly instead of quietly scoring a timeout as safety.
  if (grant) {
    await approval.settle((() => {
      let id = null;
      approval.ask({ method: 'POST', url: `${url}${hop}`, sessionKey: 's', userId: 'u' });
      id = approval.listPending()[0].id;
      return id;
    })(), { approved: true, scope: 'session' });
  }

  const seenByPlaywright = [];
  await observeViaEvents(context.pages().length ? context.pages()[0] : (await context.newPage()), context, seenByPlaywright);
  await gate.installOnContext(context, { userId: 'u', sessionKey: 's' });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  SEEN.length = 0;
  seenByPlaywright.length = 0;

  page.click(trigger).catch(() => {});
  await page.waitForTimeout(1500);

  // A REFUSED request never reaches the server, so there is no traffic to wait
  // for -- but the gate still has to record its decision, and for an UNANSWERED
  // approval that record only appears when the approval TIMES OUT (gate.js:309
  // runs after the approval promise settles). The probe runs with
  // timeoutMs: 4000, so the earliest refusal is ~4s out.
  //
  // Two wrong versions of this wait, both worth recording:
  //  1. a flat 1500ms -- read an empty audit trail and called it "not engaged".
  //  2. settling on `asked > 0` -- WRONG, because `asked` increments the moment
  //     the gate puts the question to a human, long before anyone answers. The
  //     loop exited at ~0ms with asked=1, refused=0 and no audit row, which is a
  //     gate correctly WAITING, not one that failed to engage.
  //
  // The only sound settle condition for a refusal is the audit row itself, so
  // wait for that and ignore the intermediate stats entirely.
  const deadline = Date.now() + approval.timeoutMs + 5000;
  while (Date.now() < deadline) {
    const settled = grant
      ? mutatingCount(SEEN) > 0
      // A REFUSED row specifically, not "any row". `length > 0` is a latent
      // trap: the navigation GET / is allowed SILENTLY today (gate.js:218-222,
      // allowedSilent) so it writes no row, but any future non-silent GET would
      // satisfy `length > 0` at ~0ms and E would report a false failure. It
      // would fail loud rather than silently, but it would be wrong.
      : audit.list({ decision: 'refused' }).length > 0;
    if (settled) break;
    await page.waitForTimeout(150);
  }
  // one more beat so any follow-on write lands after the row appears
  await page.waitForTimeout(400);

  function mutatingCount(list) {
    return list.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && r.path !== '/').length;
  }

  const mutatingAtServer = SEEN.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
  const mutatingSeenByPlaywright = seenByPlaywright.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
  const auditRows = audit.list().map((a) => `${a.method} ${a.url.replace(url, '/')} -> ${a.decision}`);

  console.log(`\n${label}`);
  console.log(`  server saw (mutating)     : ${mutatingAtServer.map((r) => `${r.method} ${r.path}`).join(', ') || 'nothing'}`);
  console.log(`  playwright saw (mutating) : ${mutatingSeenByPlaywright.map((r) => `${r.method} ${r.url.replace(url, '/')}`).join(', ') || 'nothing'}`);
  console.log(`  GATE HANDLED              : ${gate.stats.allowed + gate.stats.refused} (asked=${gate.stats.asked}, refused=${gate.stats.refused})`);
  console.log(`  gate audit rows           : ${auditRows.length ? auditRows.join(' | ') : 'NONE'}`);
  for (const r of mutatingAtServer) {
    console.log(`  >> landed: ${r.method} ${r.path} body=${JSON.stringify(r.body)} cookie=${JSON.stringify(r.cookie)}`);
  }

  // `problems` is declared HERE, before any use.
  //
  // It used to be declared ~12 lines further down, below the first
  // `problems.push(...)`. That is a temporal-dead-zone ReferenceError: any case
  // that produced no traffic crashed with
  //   "Cannot access 'problems' before initialization"
  // instead of reporting the problem. Two consequences, both bad: the
  // "scenario did not run" guard could never do its job, and the crash aborted
  // the whole run so later cases never executed and no SUMMARY printed.
  // Found by an auditor executing a refuse-everything gate. The lesson is the
  // general one -- a guard that crashes when it fires is worse than no guard,
  // because the crash reads like a different, louder problem.
  const problems = [];

  // Was there ANY mutating traffic to judge? If the request never left the
  // browser, "all mutating traffic had a gate decision" is vacuously true --
  // there was no traffic. This is the check that makes the rest meaningful.
  //
  // EXCEPT for a case that expects a REFUSAL: there, nothing landing IS the
  // correct outcome, and demanding traffic would be self-contradictory. The
  // gate refuses before the request leaves, so the server correctly sees none.
  // That is asserted by mustRefuse instead -- see below.
  const sawTraffic = mutatingAtServer.length > 0;
  if (!sawTraffic && !expect.mustRefuse) {
    problems.push(`expected mutating traffic (target=${target}) but the server saw none -- the scenario did not run`);
  }

  // ungated = a mutating request the server received for which the gate never
  // recorded a decision. Matched on the PATH ONLY for the path the server saw.
  const ungatedPaths = mutatingAtServer.filter((r) => !auditRows.some((row) => row.includes(` ${r.path} `) || row.includes(` ${r.path}->`)));
  const ungated = ungatedPaths.length;

  // Did the gate actually ENGAGE with this traffic? The right test is that it
  // recorded a decision, NOT that it asked.
  //
  // I first asserted `stats.asked >= 1` and it failed all four cases. That
  // assertion was wrong, and the reason matters: these cases pre-approve the
  // first hop as a session grant BEFORE the request is made, so decide() finds
  // the grant and returns 'allow' without ever asking anyone. asked === 0 is
  // the correct and desired behaviour for a granted request. Requiring 'asked'
  // would have failed every case that works exactly as designed.
  //
  // What must hold is that the gate was CONSIDERED and RECORDED something --
  // i.e. a decision exists for the traffic that arrived.
  const gateEngaged = auditRows.length > 0;
  if (!gateEngaged) {
    problems.push('gate recorded no decision at all; the gate is not engaged with this traffic');
  }
  if (expect.ungated !== undefined && ungated !== expect.ungated) {
    problems.push(`expected ungated=${expect.ungated}, got ${ungated}`);
  }

  // mustLand: assert the request landed ON THE PATH WE ASKED ABOUT, carrying a
  // body -- not merely that some mutating request carried a body.
  //
  // The first version of this check was `mutatingAtServer.some(r => r.body)`,
  // and it was too weak in a way worth recording. Hop 1 carries a body, so it
  // satisfied the check on its own: it proved "something with a body arrived",
  // which is not what "the approved request landed" means. An auditor
  // mutation-tested this by serving 200 from /r302 instead of 302 -- case C
  // kept printing 'gated' and exited 0, so a case labelled "302 downgrades the
  // POST" passed while NO redirect was ever issued. Now pinned to the path.
  if (expect.mustLand) {
    const wantPath = target;
    const landedAtTarget = mutatingAtServer.filter((r) => r.path === wantPath && r.body);
    if (!landedAtTarget.length) {
      problems.push(`expected an approved request WITH A BODY to arrive at ${wantPath}, but nothing landed there (saw: ${mutatingAtServer.map((r) => `${r.method} ${r.path} body=${r.body.length}b`).join(', ') || 'nothing'})`);
    }
  }

  // The shape of what landed matters as much as that something landed. A case
  // labelled "302 downgrades the POST" must not be able to pass while the
  // server issues no 302 at all, so the redirect the case claims to exercise is
  // asserted directly rather than inferred from the absence of a second hop.
  if (expect.hopStatus !== undefined) {
    const atTarget = SEEN.filter((r) => r.path === target);
    const issued = atTarget.map((r) => r.redirectsTo);
    if (!issued.length) {
      problems.push(`the server never received a request at ${target}, so no redirect status can be asserted`);
    } else if (expect.hopStatus === null) {
      // This case is specifically "no redirect". Assert the absence of one,
      // rather than inferring it from there being no second hop.
      const anyRedirect = issued.filter((s) => s !== null && s !== undefined);
      if (anyRedirect.length) {
        problems.push(`expected NO redirect from ${target}, but it issued ${anyRedirect.join(', ')} -- this case no longer measures what it is named for`);
      }
    } else {
      // `every`, not `includes`. An auditor showed `includes` lets a case pass
      // when SEEN holds BOTH a 302 and a 200 for the same path -- i.e. a case
      // labelled "302 downgrades the POST" is green while half its requests
      // got no downgrade at all. Latent on a single request, reachable on retry.
      if (!issued.length || !issued.every((s) => s === expect.hopStatus)) {
        problems.push(`expected EVERY response from ${target} to be a ${expect.hopStatus} (the behaviour under test), but got: ${issued.map((s) => s ?? 'no redirect').join(', ')}`);
      }
    }
  }

  // A gate that allows EVERYTHING would satisfy every check above: it would
  // record audit rows (so gateEngaged passes), and the granted request would
  // land (so mustLand passes). Nothing above distinguishes a gate that
  // DISCRIMINATES from one that rubber-stamps.
  //
  // So: the cases that grant only hop 1 assert that the gate actually REFUSED
  // something -- specifically that the un-approved /hop2 carries no gate
  // decision. That is the property a rubber-stamp cannot fake: it cannot both
  // allow the granted hop and leave the ungranted hop undecided.
  if (expect.ungatedHop) {
    const hopDecided = auditRows.some((row) => row.includes(expect.ungatedHop));
    if (hopDecided) {
      problems.push(`${expect.ungatedHop} was NOT expected to carry a gate decision -- if it does, this case is no longer measuring an un-approved hop`);
    }
  }
  if (expect.mustRefuse) {
    // A refusal means the gate stopped the request BEFORE it left the browser,
    // so the correct observable outcome is: a refusal in the audit trail AND no
    // body at the target. Nothing may have landed there.
    const anyRefused = auditRows.some((row) => row.includes('refused'));
    if (!anyRefused) {
      problems.push('expected a refusal in the audit trail; the gate approved an ungranted request, so it cannot discriminate');
    }
    const leaked = mutatingAtServer.filter((r) => r.path === target && r.body);
    if (leaked.length) {
      problems.push(`an UNGRANTED request reached ${target} with a body (${leaked.length}x) -- the gate allowed it, which is the failure this case exists to catch`);
    }
    // No redirect status can be asserted: the request never got far enough for
    // the server to answer one. hopStatus is deliberately omitted for this case.
  }

  const verdict = ungated ? 'UNGATED EGRESS (gate never saw it)' : 'all mutating traffic had a gate decision';
  console.log(`  VERDICT                   : ${verdict}`);
  if (problems.length) {
    for (const p of problems) console.log(`  !! ${p}`);
  }

  await browser.close();
  await new Promise((r) => srv.close(r));
  return { ungated, landed: mutatingAtServer.map((r) => `${r.method} ${r.path}`), problems, sawTraffic, asked: gate.stats.asked };
}

if (!CAMOUFOX_BIN) {
  console.error('set CAMOUFOX_BIN');
  process.exit(2);
}

// `target` is what the page requests. `hop` is what the grant covers. They are
// written out separately and asserted equal at run time, because the original
// bug WAS a silent mismatch between them.
const cases = [
  // A and B are the headline bypass. UNCHANGED in substance: grant covers the
  // first hop, the second hop escapes. Do not "fix" these -- they are the
  // evidence, re-verified 3x on 78b41d8.
  //
  // `hopStatus` asserts the server really issued a 307 (an auditor showed a
  // case could pass while NO redirect happened at all), and `ungatedHop`
  // asserts /hop2 carries NO gate decision -- which is what makes the ungated
  // count meaningful rather than merely zero.
  { label: 'A  fetch POST, 307, one grant for hop 1', target: '/r307', hop: 'r307', trigger: '#jsfetch', grant: true,
    expect: { ungated: 1, hopStatus: 307, ungatedHop: '/hop2' } },
  { label: 'B  navigating <form method=post>, 307', target: '/r307', hop: 'r307', trigger: '#postform', grant: true,
    expect: { ungated: 1, hopStatus: 307, ungatedHop: '/hop2' } },

  // C: the 302 downgrade control. Now genuinely hits a route that serves 302
  // (/r302), with the grant covering that same route. Expects NO mutating
  // egress: the POST is downgraded to GET, so no body reaches /hop2.
  // `hopStatus: 302` is the load-bearing part -- it is what stops this case
  // passing while the server serves 200 and no redirect occurs.
  { label: 'C  fetch POST, 302 (downgrades to GET)', target: '/r302', hop: 'r302', trigger: '#jsfetch', grant: true,
    expect: { ungated: 0, mustLand: true, hopStatus: 302 } },

  // D: the POSITIVE control. A non-redirecting route, so an approved POST must
  // actually arrive. Before, D pointed the grant at /hop2 while the button
  // posted to /r307 -- nothing landed and it was scored 'gated', which is the
  // exact opposite of what its own label promised.
  { label: 'D  no redirect, one grant (must still land)', target: '/direct', hop: 'direct', trigger: '#jsfetch', grant: true,
    expect: { ungated: 0, mustLand: true, hopStatus: null } },

  // E: added 5 Oct 2026. THE DISCRIMINATION CASE.
  //
  // A, C and D all pass against a gate that approves EVERYTHING -- it writes
  // audit rows, and the granted request lands. An auditor mutation-tested
  // `grantCovers => true` unconditionally and the suite stayed green, which
  // means nothing here proved the gate can say no.
  //
  // E grants NOTHING, so the gate must REFUSE. If it does not, every other case
  // in this file is measuring a rubber stamp. A gate that cannot refuse cannot
  // be bypassed, and that has to be shown before "bypass" means anything.
  //
  // NOTE what is deliberately NOT asserted here, because I got it wrong first:
  // no `mustLand`, no `hopStatus`, no `sawTraffic`. A correct refusal stops the
  // request BEFORE it leaves the browser, so the server sees NOTHING -- which
  // is exactly the outcome that must NOT be scored as "the scenario did not
  // run". Asserting traffic here would have made a working gate look broken.
  // `ungated: 0` is still right: no mutating request arrived ungated, because
  // none arrived at all.
  { label: 'E  fetch POST, NO grant (must be refused)', target: '/r307', hop: 'r307', trigger: '#jsfetch', grant: false,
    expect: { ungated: 0, mustRefuse: true } },

  // F: added 5 Oct 2026 after round 3. THE GRANT-PREDICATE CASE.
  //
  // E grants nothing, so `grantCovers()` is never called -- decide()'s loop over
  // grants (policy.js:204-208) has nothing to iterate. An auditor measured this
  // directly: `grants in list = 0`. So E proves the gate refuses an ABSENT
  // grant; it cannot prove the gate declines a grant that covers the WRONG
  // thing.
  //
  // That left three mutations scoring GREEN: `grantCovers => true`, dropping
  // the URL comparison, and dropping the method comparison. All three make a
  // grant cover requests it should not -- and no case asked that question,
  // because every granting case registered a grant for the URL it then
  // requested. A one-time grant for a DIFFERENT url, requesting another.
  //
  // This is the case the repo's own §7.2 incident argues for: an approval for
  // one endpoint must not become a standing pass for another.
  { label: 'F  grant for a DIFFERENT url (must not carry over)', target: '/r307', hop: 'someOtherUrl', trigger: '#jsfetch', grant: true,
    intentionalMismatch: true,
    expect: { ungated: 0, mustRefuse: true, mustNotLand: true } },
];

const results = [];
for (const c of cases) {
  // The pre-flight guard from round 1: a case whose grant does not cover the URL
  // its trigger requests is the ORIGINAL defect, and must not run.
  //
  // Case F deliberately breaks this -- that is its entire purpose -- so it opts
  // out via an explicit flag. The opt-out has to be visible here, at the point
  // of the check, rather than inferred from the case body.
  const miswired = c.hop !== c.target.replace(/^\//, '');
  if (miswired && !c.intentionalMismatch) {
    console.error(`\n${c.label}\n  !! MISWIRED: grant covers '${c.hop}' but the page requests '${c.target}'.`);
    console.error('     This is the original defect. Fix the case before trusting its result.');
    process.exit(2);
  }
  if (miswired) {
    console.log(`\n${c.label}\n  (intentional mismatch: the grant covers '${c.hop}', the page requests '${c.target}')`);
  }
  results.push([c.label, await run(c.label, c)]);
}

console.log('\nSUMMARY');
let failed = 0;
for (const [label, r] of results) {
  const bad = r.problems.length > 0;
  if (bad) failed++;
  console.log(`  ${bad ? 'INVALID' : r.ungated ? 'BYPASS ' : 'gated '} ${label} :: landed ${r.landed.join(', ') || 'nothing'}`);
  for (const p of r.problems) console.log(`      !! ${p}`);
}

if (failed) {
  console.log(`\n${failed} of ${results.length} cases did not demonstrate what they claim.`);
  console.log('An INVALID case is worse than a red one: it looks like evidence and is not.');
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} cases ran the scenario they claim and produced the expected result.`);
  console.log('A and B BYPASS  = the 307 second hop is real and is NOT prevented.');
  console.log('C gated         = 302 really does downgrade a POST to GET; no body reaches /hop2.');
  console.log('D gated + landed= an approved direct POST does arrive. The gate is not blocking everything.');
  console.log('E refused       = the gate can SAY NO. Without this, A-D would also pass against a');
  console.log('                   gate that approves everything, and none of them would prove anything.');
}
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

/** Hop 1 answers 307 to /hop2; hop 2 is where the body and cookie land. */
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        SEEN.push({ method: req.method, path: req.url, body, cookie: req.headers.cookie ?? null });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><meta charset=utf-8><title>redirect probe</title>
<button id="jsfetch" onclick="fetch('/r307',{method:'POST',body:'card=4111111111111111',credentials:'include'})">Pay now</button>
<form method="post" action="/r307"><input name="card" value="4111111111111111"><button id="postform" type="submit">Pay by form</button></form>
`);
        } else if (req.url === '/r307') {
          // 307 preserves method AND body. 308 is the same for our purposes.
          res.writeHead(307, { Location: '/hop2' });
          res.end();
        } else if (req.url === '/hop302') {
          // 302 downgrades POST to GET and drops the body -- the safe case.
          res.writeHead(302, { Location: '/hop2' });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/json' });
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

async function run(label, { hop, trigger, grant }) {
  const { srv, url } = await startServer();
  const browser = await firefox.launch({ headless: true, executablePath: CAMOUFOX_BIN });
  const context = await browser.newContext();
  const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 4000 });
  const audit = createAuditLog();
  const gate = createEgressGate({ approval, audit });

  // One approval granted up front for the FIRST hop only, which is exactly the
  // shape of the reported bypass: one human yes, then an unapproved second hop.
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
  const ungated = mutatingAtServer.filter((r) => !auditRows.some((row) => row.includes(r.path)));
  console.log(`  VERDICT                   : ${ungated.length ? 'UNGATED EGRESS (gate never saw it)' : 'all mutating traffic had a gate decision'}`);

  await browser.close();
  await new Promise((r) => srv.close(r));
  return { ungated: ungated.length, landed: mutatingAtServer.map((r) => `${r.method} ${r.path}`) };
}

if (!CAMOUFOX_BIN) {
  console.error('set CAMOUFOX_BIN');
  process.exit(2);
}

const results = [];
results.push(['fetch POST -> 307 -> /hop2, approval granted for hop 1', await run('A  fetch POST, 307, one grant for hop 1', { hop: 'r307', trigger: '#jsfetch', grant: true })]);
results.push(['navigating form POST -> 307 -> /hop2', await run('B  navigating <form method=post>, 307', { hop: 'r307', trigger: '#postform', grant: true })]);
results.push(['fetch POST -> 302 -> /hop2 (downgrade control)', await run('C  fetch POST, 302 (downgrades to GET)', { hop: 'hop302', trigger: '#jsfetch', grant: true })]);
results.push(['fetch POST, no redirect, grant granted (positive control)', await run('D  no redirect, one grant (must still land)', { hop: 'hop2', trigger: '#jsfetch', grant: true })]);

console.log('\nSUMMARY');
for (const [label, r] of results) {
  console.log(`  ${r.ungated ? 'BYPASS ' : 'gated '} ${label} :: landed ${r.landed.join(', ') || 'nothing'}`);
}
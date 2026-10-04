// THE DEMO. One real shop, one real checkout, Lodestar in the path.
//
//   export CAMOUFOX_BIN=~/Library/Caches/camoufox/browsers/official/*/Camoufox.app/Contents/MacOS/camoufox
//   node demos/shop-demo.mjs
//
// WHY THIS PAGE IS BUILT THE WAY IT IS
//
// The previous version pressed the buttons itself and let the human answer
// whatever dialog appeared. That produced a real failure: the run logged THREE
// approvals and the human remembered TWO. Three identical-looking dialogs in a
// row, no step number, no way to tell which one you had just cleared -- so the
// log and the only other witness disagreed, with no way to settle it.
//
// An ambiguous witness is worse than no witness. Now:
//
//   1. YOU press the buttons. This script never dispatches a click.
//   2. Every dialog names the step it belongs to, read from the page.
//   3. One running transcript is rendered ON THE PAGE, and the same entries
//      print to the terminal. Both of us read the same ordered list, so there
//      is nothing left to reconcile afterwards.
//   4. The window never closes itself. You close it, or it holds for HOLD_MS.
//
// The three steps, in order:
//
//   STEP 1  Add to bag        POST /cart -- mutating, must ask
//   STEP 2  Add to bag again  POST /cart -- IDENTICAL body. A dialog MUST appear
//                              again. Before the d6fbe8e fix this sailed through
//                              silently on a spent grant.
//   STEP 3  Pay GBP 49.00     POST /pay  -- carries a card number
//
// Approving step 3 proves the gate is a DECISION point, not a blanket refusal.

import http from 'node:http';
import { firefox } from 'playwright-core';
import { createApprovalSurface } from '../plugins/egress-gate/lib/approval.js';
import { createAuditLog } from '../plugins/egress-gate/lib/audit.js';
import { createEgressGate } from '../plugins/egress-gate/lib/gate.js';

const HEADED = process.env.HEADED !== '0';
const BIN = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
if (!BIN) { console.error('set CAMOUFOX_BIN'); process.exit(2); }

// How long to wait for a human at each step before calling the run inconclusive.
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 240000);

// ---------------------------------------------------------------- the shop

const CARD = '4242424242424242';
const seen = [];

const PAGE = `<!doctype html><meta charset=utf-8>
<title>Lodestar Demo Shop</title>
<style>
 body{font:15px/1.55 -apple-system,sans-serif;max-width:780px;margin:28px auto;padding:0 20px;color:#111}
 h1{font-size:22px;margin:0 0 2px}
 .sub{color:#666;font-size:13px;margin-bottom:18px}
 .bar{background:#111;color:#fff;padding:14px 18px;border-radius:10px;margin:0 0 16px;font-size:14px}
 .bar b{color:#fbbf24}
 button{font:inherit;font-weight:600;padding:11px 18px;margin:0 8px 8px 0;cursor:pointer;
        border-radius:8px;border:1px solid #bbb;background:#fff}
 button.pay{background:#111;color:#fff;border-color:#111}
 .row{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:13px;color:#555}
 .row input{font:inherit;padding:7px;width:220px;border:1px solid #ccc;border-radius:6px}
 pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:10px;font:12.5px/1.7 ui-monospace,Menlo,monospace;
     max-height:44vh;overflow:auto;white-space:pre-wrap}
 h2{font-size:15px;margin:20px 0 8px}
</style>

<h1>Lodestar demo shop</h1>
<div class="sub">Press the buttons <b>yourself</b>. The script will not press them for you.</div>

<div class="bar">
  <b>YOU drive this test.</b> Press step 1, answer the dialog, then step 2, answer the
  dialog, then step 3. Every dialog names its step. Nothing closes until you close it.
</div>

<div class="row"><input id="q" value="widget"><button id="search">Search (GET &mdash; should never ask)</button></div>

<div style="margin:14px 0">
  <button id="add">STEP 1 &mdash; Add to bag</button>
  <button id="add2">STEP 2 &mdash; Add to bag again (identical body)</button>
  <button id="pay" class="pay">STEP 3 &mdash; Pay &pound;49.00 (carries a card number)</button>
</div>

<h2>Running transcript &mdash; the same list prints to the terminal</h2>
<pre id="t">waiting for you to press STEP 1...</pre>

<script>
 // One ordered transcript. The terminal prints the same entries, so the human
 // and the log can never tell different stories about the same run.
 window.__lodestar = { step: 0, transcript: [] };

 function render() {
   const el = document.getElementById('t');
   el.textContent = window.__lodestar.transcript.join('\\n')
     || 'waiting for you to press STEP 1...';
   el.scrollTop = el.scrollHeight;
 }
 window.__say = function (who, text) {
   const tag = { you:'[YOU]  ', gate:'[GATE]', srv:'[SRV] ', bad:'[FAIL]' }[who] || '[....]';
   const line = tag + ' ' + text;
   window.__lodestar.transcript.push(line);
   render();
   return line;
 };

 async function post(path, body) {
   const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'},
                                body: JSON.stringify(body)});
   return {status: r.status, text: await r.text()};
 }

 // STEP 1 and STEP 2 send a byte-identical body on purpose. That is the point:
 // a one-time approval must not become a standing grant for the same payload.
 function wireCart(id, n, what) {
   document.getElementById(id).onclick = async () => {
     window.__lodestar.step = n;
     // Publish to the DOM as well. The driver cannot read page globals on this
     // engine (page.evaluate runs in an isolated world), so a data attribute on
     // <body> is the only channel that carries this value back to the script.
     document.body.dataset.step = String(n);
     window.__say('gate', 'step ' + n + ' (' + what + ') -- you pressed the button.');
     try {
       const r = await post('/cart', {sku:'widget-1', qty:1});
       window.__say('srv', 'server RECEIVED POST /cart -> ' + r.status + ' ' + r.text);
     } catch (e) {
       window.__say('bad', 'POST /cart did NOT reach the server: ' + e.message);
     }
   };
 }
 wireCart('add', 1, 'Add to bag');
 wireCart('add2', 2, 'Add to bag AGAIN, identical body');

 // CARD is interpolated here because this template literal is rendered into the
 // BROWSER. A bare CARD is a Node-scope identifier that is undefined there:
 // pay() threw a ReferenceError, its own try/catch swallowed it into a page
 // message, and the gate was never asked about /pay at all. The demo then
 // reported INCONCLUSIVE, which is indistinguishable from a gate correctly
 // waiting on a human.
 document.getElementById('pay').onclick = async () => {
   window.__lodestar.step = 3;
   document.body.dataset.step = '3';
   window.__say('gate', 'step 3 (Pay, carries a card number) -- you pressed the button.');
   try {
     const r = await post('/pay', {card: '${CARD}', amount: 49, cvc:'123'});
     window.__say('srv', '*** SERVER RECEIVED POST /pay *** -> ' + r.status + ' ' + r.text);
   } catch (e) {
     window.__say('bad', 'POST /pay did NOT reach the server: ' + e.message);
   }
 };

 document.getElementById('search').onclick = async () => {
   const q = document.getElementById('q').value;
   const r = await fetch('/search?q=' + encodeURIComponent(q));
   window.__say('srv', 'server RECEIVED GET /search -> ' + r.status
     + '   (a GET must never ask -- a dialog here would be a defect)');
 };
 render();
</script>`;

function startServer() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/search') {
      seen.push('GET /search');
      return json(200, { results: ['widget'] });
    }
    if (req.method === 'POST' && url.pathname === '/cart') {
      seen.push('POST /cart');
      return json(200, { ok: true, inBag: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/pay') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        seen.push('POST /pay');
        console.log('  [SERVER] *** PAYMENT LANDED *** body=' + body);
        json(200, { paid: true, amount: 49 });
      });
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r =>
    srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

// ---------------------------------------------------------------- the gate

const { srv, url } = await startServer();
console.log(`demo shop on ${url}`);

const audit = createAuditLog({ log: (...a) => console.log('  [GATE]', ...a) });

// approval.js has no presenter of its own -- it holds a pending map and emits
// nothing to a human. The real product wires that to the app's event bus. Here
// it is wired to a dialog injected into the page, so the prompt appears in the
// window you are watching, in the page you are acting on.
// Generous on purpose: the lib's default is 20s, and an expiry mid-demo looks
// identical to a refusal. Long enough that only a real non-answer times out.
const approval = createApprovalSurface({
  mode: 'ask',
  timeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 240000),
  // Without this the gate's own "awaiting human approval" line never prints, so
  // a silent run is indistinguishable from a press that never reached the gate.
  log: (level, message, fields) => console.log('  [GATE]', message, fields ?? {}),
});

const gate = createEgressGate({ approval, audit, log: (...a) => console.log('  [GATE]', ...a) });

// ---------------------------------------------------------------- the run

const browser = await firefox.launch({ headless: !HEADED, executablePath: BIN });
const context = await browser.newContext();

console.log('installing the gate...');
const registered = gate.installOnContext(context, { userId: 'demo' });
if (!registered) {
  console.error('gate FAILED to install -- refusing to run, that is the fail-closed path');
  process.exit(3);
}
console.log('gate installed.');

const page = await context.newPage();
await page.goto(url, { waitUntil: 'load' });
page.on('pageerror', e => {
  console.log('  [PAGE ERROR]', e.message.split('\n')[0]);
  mirror('bad', 'the page threw: ' + e.message.split('\n')[0]);
});

const pause = (ms) => new Promise(r => setTimeout(r, ms));

// Mirror a terminal line into the page transcript, so the human sees the gate's
// own account of what it did without switching windows.
function mirror(who, text) {
  page.locator('#t').evaluate(
    (el, [w, t]) => window.__say(w, t), [who, text]).catch(() => {});
}

// Read the current step across the isolated-world boundary.
//
// page.evaluate() cannot see page globals on this engine, so this reads a data
// attribute the page's own script writes. Verified against the engine: the page
// sets window.__lodestar.step correctly and the DOM carries the same value,
// while reading window.__lodestar from the driver returns undefined.
async function readStepFromPage() {
  const attr = await page.locator('body').getAttribute('data-step').catch(() => null);
  return attr === null ? 0 : Number(attr);
}

// The approval dialog, labelled with the step it belongs to. The step number is
// READ FROM THE PAGE rather than guessed, because the page is what knows which
// button was pressed. Guessing here is how the last run became unreadable.
//
// It is read from a DOM attribute, NOT from window.__lodestar. This engine is
// anti-detection, so page.evaluate() runs in an ISOLATED WORLD and cannot see
// page globals: the page's own scripts do set window.__lodestar.step (verified
// -- the DOM shows the values), but reading it from the driver returns
// undefined forever. The DOM is shared between the two worlds, so a data
// attribute is the only channel that actually carries a value across.
let dialogSeq = 0;
const decisions = [];
const stopPrompt = setInterval(async () => {
  const pending = approval.listPending();
  if (!pending.length) return;

  for (const entry of pending) {
    if (entry.__shown) continue;
    entry.__shown = true;
    dialogSeq += 1;

    // listPending() maps to entry.record, so the fields are on `entry` itself.
    // Reading entry.record.method gave undefined and printed '?'.
    const rec = entry.record ? entry.record : entry;
    const stepNo = Number(await readStepFromPage()) || 0;
    const digest = rec.fingerprint?.digest ?? null;

    const ask = `STEP ${stepNo} of 3 -- the gate is asking about ${rec.method} ${rec.url}`
              + (digest
                  ? `\nbody digest ${digest.slice(0, 8)} (the body is never shown or stored)`
                  : '\nno body digest -- treated as unknown, not as safe');

    let choice;
    try {
      choice = await page.evaluate((d) => new Promise((res) => {
        const box = document.createElement('div');
        box.id = 'lodestar-dialog';
        box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;'
          + 'align-items:center;justify-content:center;z-index:2147483647;font:15px -apple-system,sans-serif';
        box.innerHTML = '<div style="background:#fff;padding:26px 28px;border-radius:12px;'
          + 'max-width:580px;box-shadow:0 20px 60px rgba(0,0,0,.45)">'
          + '<div style="font-size:12px;letter-spacing:.09em;color:#b45309;font-weight:700">LODESTAR</div>'
          + '<h2 style="margin:8px 0 4px;font-size:20px">Irreversible action requested</h2>'
          + '<pre style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:13px;'
          + 'white-space:pre-wrap;overflow:auto;max-height:190px">'
          + d.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>'
          + '<div style="margin-top:18px;display:flex;gap:10px">'
          + '<button id="no"  style="flex:1;padding:12px;border-radius:8px;border:1px solid #ccc;'
          + 'background:#fff;font:inherit;cursor:pointer">Refuse</button>'
          + '<button id="yes" style="flex:1;padding:12px;border-radius:8px;border:0;'
          + 'background:#111;color:#fff;font:inherit;cursor:pointer;font-weight:600">Approve once</button>'
          + '</div></div>';
        document.body.appendChild(box);
        box.querySelector('#yes').onclick = () => { box.remove(); res(true); };
        box.querySelector('#no').onclick  = () => { box.remove(); res(false); };
      }), ask);
    } catch {
      return; // browser closed underneath us; nothing left to approve
    }

    const verb = choice ? 'APPROVED' : 'REFUSED';
    const what = `${rec.method ?? '?'} ${rec.url ?? '?'}`;
    console.log(`  dialog ${dialogSeq}: you ${verb} ${what}`
      + ` for STEP ${stepNo}${digest ? `  (digest ${digest.slice(0, 8)})` : ''}`);
    decisions.push({ verb, method: rec.method ?? null, url: rec.url ?? null,
                     digest, step: stepNo, id: entry.id, seq: dialogSeq });
    mirror(page, 'you', `${verb === 'APPROVED' ? 'Approve once' : 'Refuse'} on the STEP ${stepNo} dialog.`);
    approval.settle(entry.id, { approved: choice, scope: 'once' });
  }
}, 200);

// Wait for the HUMAN to press a given step's button. This script never clicks.
async function waitForStep(n, label) {
  const secs = Math.round(STEP_TIMEOUT_MS / 1000);
  console.log(`\n>>> On the page: press "${label}"  (waiting up to ${secs}s)`);
  const t0 = Date.now();
  while (Date.now() - t0 < STEP_TIMEOUT_MS) {
    const s = await readStepFromPage();
    if (s >= n) { await pause(1500); return true; }
    await pause(250);
  }
  console.log(`  !! you never pressed step ${n}`);
  mirror('bad', `step ${n} was never pressed -- the run cannot continue.`);
  return false;
}

console.log('\npage loaded. window should be open.');
console.log('Read the page: it lists every step, every dialog, and what the server received.');

let ranOut = false;

// --- STEP 1
if (!await waitForStep(1, 'STEP 1 -- Add to bag')) ranOut = true;

// --- STEP 2: identical body. A dialog MUST appear again.
if (!ranOut) {
  console.log('\n>>> Answer the STEP 1 dialog first, then press STEP 2 on the page.');
  console.log('>>> A SECOND dialog MUST appear. Before the fix it did not.');
  if (!await waitForStep(2, 'STEP 2 -- Add to bag again (identical body)')) ranOut = true;
}

// --- STEP 3: the one that matters
if (!ranOut) {
  console.log('\n>>> Answer the STEP 2 dialog, then press STEP 3 -- Pay.');
  console.log('>>> Approving it proves the decision carries through. Refusing proves fail-closed.');
  if (!await waitForStep(3, 'STEP 3 -- Pay (card number)')) ranOut = true;
}

// Let the last request settle, then let the human read before anything closes.
console.log('\n>>> All steps pressed. Letting the last request settle...');
await pause(3000);

// Distinguish "the gate held it" from "the run ended before anyone decided".
// Only the first is a result. Conflating them is how you get a green that means
// nothing -- an undecided approval and a refusal look identical from outside.
// Match decisions to what was ASKED, not to how many were answered. Counting
// approvals and inferring intent from the count is how "you REFUSED" got
// printed after three approvals.
const askedAbout = (frag) => decisions.filter(d => String(d.url ?? '').includes(frag));
const payDecisions = askedAbout('/pay');
const cartDecisions = askedAbout('/cart');
const payLanded = seen.includes('POST /pay');
const payApproved = payDecisions.some(d => d.verb === 'APPROVED');
const payRefused  = payDecisions.some(d => d.verb === 'REFUSED');
const cartPosts = seen.filter(x => x === 'POST /cart').length;

console.log('\n===== RESULT ' + '='.repeat(42));
console.log('server received :', JSON.stringify(seen));

console.log('\n  --- dialogs you answered, in order ---');
if (!decisions.length) console.log('  (none)');
for (const d of decisions) {
  console.log(`  ${d.seq}. STEP ${d.step}: ${d.verb.padEnd(9)} ${d.method ?? '?'} ${d.url ?? '?'}`);
}

// The gate's own account of what it decided, so the verdict is not based only
// on what the human thinks they clicked.
console.log('\n===== THE GATE\'S OWN AUDIT ' + '='.repeat(34));
const rows = audit.list ? audit.list({ limit: 50 }) : [];
if (!rows.length) console.log('  (audit empty)');
for (const r of rows) {
  console.log(`  ${String(r.decision).padEnd(8)} ${r.method ?? '?'} ${r.url ?? '?'}  ${r.reason ?? ''}`
    + (r.grantedScope ? `  scope=${r.grantedScope}` : ''));
}
console.log(`\n  counts: ${JSON.stringify(audit.counts())}`);

console.log('\n===== VERDICT ' + '='.repeat(40));
if (ranOut) {
  console.log('INCONCLUSIVE. You did not press every step, so there is nothing to judge.');
} else if (payLanded && payApproved) {
  console.log('CORRECT AND DEMONSTRATED. You approved POST /pay and it landed.');
  console.log('  The gate asked, a human decided, and the decision was carried out.');
  console.log('  That is the product: not a refusal, a decision.');
} else if (payLanded && !payApproved && !payRefused) {
  console.log('*** DEFECT: the payment landed with NO approval dialog for it ***');
  console.log('  Decide the rest of this yourself; do not ship this build.');
} else if (payRefused && !payLanded) {
  console.log('CORRECT AND DEMONSTRATED. You REFUSED POST /pay and it was held.');
  console.log('  The card number never left the machine. That is the product.');
} else if (payDecisions.length === 0) {
  console.log('INCONCLUSIVE. POST /pay was never put to you.');
  console.log('  The page transcript says whether the request left the browser at all.');
} else {
  console.log('INCONCLUSIVE. The payment did not land and you did not refuse it.');
  console.log(`  payment decisions: ${JSON.stringify(payDecisions)}`);
  console.log('  This is neither a pass nor a hold -- something else went wrong.');
}

// The grant fix, judged on what actually reached the server.
console.log('\n===== ONE-TIME GRANT CHECK ' + '='.repeat(28));
console.log(`  cart dialogs answered : ${cartDecisions.length}`);
console.log(`  POST /cart on server  : ${cartPosts}`);
if (cartDecisions.length === 0) {
  console.log('  UNTESTED -- no cart dialog was answered this run.');
} else if (cartPosts > cartDecisions.filter(d => d.verb === 'APPROVED').length) {
  console.log('  *** DEFECT: more POST /cart landed than were approved ***');
} else {
  console.log('  CORRECT. Every POST /cart on the server was approved one-for-one.');
  console.log('  A repeat asked again instead of matching a spent grant.');
}

const passed = (payLanded && payApproved) || (payRefused && !payLanded);
mirror(passed ? 'srv' : 'bad',
  passed ? 'VERDICT: CORRECT AND DEMONSTRATED -- full breakdown is in the terminal.'
        : 'VERDICT: INCONCLUSIVE -- the terminal says why.');

const holdMs = Number(process.env.HOLD_MS || 900000);
console.log('\n>>> The window stays open so you can read the transcript. Close it yourself.');
console.log(`>>> Holding for ${Math.round(holdMs / 60000)} minutes, then closing.`);

// Hold the window open for the human. Bounded so a forgotten run cannot outlive
// the session, but long enough to actually read the transcript.
await pause(holdMs);

stopPrompt();
await browser.close();
srv.close();
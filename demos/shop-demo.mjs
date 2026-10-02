// THE DEMO. One real shop, one real checkout, Lodestar in the path.
//
// This is not a probe and not a test. It is the end-to-end run: a real browser,
// a real page, a real irreversible POST, and a gate that decides about it in
// front of you. Run it headed and watch the window.
//
//   export CAMOUFOX_BIN=~/Library/Caches/camoufox/browsers/official/*/Camoufox.app/Contents/MacOS/camoufox
//   node demos/shop-demo.mjs
//
// Three runs, in order, so you see the gate make a decision rather than just
// block everything:
//
//   1. BROWSE   - loads the shop, searches, opens the product. GETs only.
//                 Should sail through. This is the case that must NOT be slow
//                 enough to make someone turn the gate off.
//   2. ADD TO BAG + CHECKOUT - an actual POST that costs nothing but is still
//                 mutating. Gate asks.
//   3. PAY - POST /pay with a card number in the body. Gate asks again.
//                 Approve it and the payment lands. This is the one that proves
//                 the gate is a decision point and not a blanket refusal.
//
// The approval prompt is IN the browser window, not a terminal dialog, so what
// you see is what an operator would see.

import http from 'node:http';
import { firefox } from 'playwright-core';
import { createApprovalSurface } from '../plugins/egress-gate/lib/approval.js';
import { createAuditLog } from '../plugins/egress-gate/lib/audit.js';
import { createEgressGate } from '../plugins/egress-gate/lib/gate.js';

const HEADED = process.env.HEADED !== '0';
const BIN = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
if (!BIN) { console.error('set CAMOUFOX_BIN'); process.exit(2); }

// ---------------------------------------------------------------- the shop

const CARD = '4242424242424242';
const seen = [];

const PAGE = `<!doctype html><meta charset=utf-8>
<title>Lodestar Demo Shop</title>
<style>
 body{font:16px/1.5 -apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#111}
 h1{font-size:24px} button{font:inherit;padding:10px 18px;margin:4px 4px 4px 0;cursor:pointer}
 input{font:inherit;padding:8px;width:260px;margin:8px 0}
 .box{border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;background:#fafafa}
 #log{font:13px ui-monospace,monospace;background:#111;color:#0f0;padding:12px;border-radius:8px;white-space:pre-wrap}
 .warn{color:#b00;font-weight:600}
</style>

<h1>Lodestar Demo Shop</h1>
<p>A shop with one product and a checkout that really does take a card.</p>

<div class=box>
  <input id=q placeholder="search: widget">
  <button onclick="search()">Search</button>
</div>

<div class=box>
  <h2>Widget &mdash; &pound;49.00</h2>
  <p>In stock. Ships tomorrow.</p>
  <button id=add onclick="addToBag()">Add to bag</button>
  <button id=pay onclick="pay()">Pay &pound;49.00</button>
</div>

<h2>What the server received</h2>
<div id=log>nothing yet</div>

<script>
 let bag = 0; void bag;
 async function post(path, body) {
   const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'},
                                body: JSON.stringify(body)});
   return {status: r.status, text: await r.text()};
 }
 async function show(msg) {
   const el = document.getElementById('log');
   el.textContent = msg + String.fromCharCode(10) + '---' + String.fromCharCode(10) + el.textContent;
 }
 async function search() {
   const q = document.getElementById('q').value;
   const r = await fetch('/search?q=' + encodeURIComponent(q));
   show('SEARCH ' + q + ' -> ' + r.status);
 }
 async function addToBag() {
   bag++;
   const r = await post('/cart', {sku:'widget-1', qty:1});
   show('ADD TO BAG -> ' + r.status + ' ' + r.text + '  (bag=' + bag + ')');
 }
 async function pay() {
   show('PAYING... (if the gate asks, approve in the dialog)');
   try {
     const r = await post('/pay', {card: CARD, amount: 49, cvc:'123'});
     show('PAY -> ' + r.status + ' ' + r.text);
   } catch (e) {
     show('PAY BLOCKED: ' + e.message);
   }
 }
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
const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 90000 });

const gate = createEgressGate({ approval, audit, log: (...a) => console.log('  [GATE]', ...a) });

// The human side. A poll for pending approvals, rendered as a dialog in the
// page itself. This is the piece the product does not have yet -- in the real
// thing this would be a push to the operator's UI. Here it is a real prompt in
// a real window, which is the part that matters for the demo.
function startApprovalPrompt(pg, decisions) {
  let seenIds = new Set();
  const timer = setInterval(async () => {
    const pending = approval.listPending();
    if (!pending.length) return;
    for (const entry of pending) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);

      const detail = entry.request ? JSON.stringify(entry.request) : '';
      let choice;
      try {
        choice = await pg.evaluate((d) => new Promise((res) => {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;'
          + 'align-items:center;justify-content:center;z-index:2147483647;font:15px -apple-system,sans-serif';
        box.innerHTML = '<div style="background:#fff;padding:26px 28px;border-radius:12px;'
          + 'max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.4)">'
          + '<div style="font-size:12px;letter-spacing:.09em;color:#b45309;font-weight:700">LODESTAR</div>'
          + '<h2 style="margin:8px 0 4px;font-size:20px">Irreversible action requested</h2>'
          + '<pre style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:12px;'
          + 'white-space:pre-wrap;overflow:auto;max-height:170px">'
          + d.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>'
          + '<div style="margin-top:18px;display:flex;gap:10px">'
          + '<button id="no"  style="flex:1;padding:11px;border-radius:8px;border:1px solid #ccc;'
          + 'background:#fff;font:inherit;cursor:pointer">Refuse</button>'
          + '<button id="yes" style="flex:1;padding:11px;border-radius:8px;border:0;'
          + 'background:#111;color:#fff;font:inherit;cursor:pointer;font-weight:600">Approve once</button>'
          + '</div></div>';
        document.body.appendChild(box);
        box.querySelector('#yes').onclick = () => { box.remove(); res(true); };
        box.querySelector('#no').onclick  = () => { box.remove(); res(false); };
        }), detail);
      } catch {
        // browser closed underneath us; nothing left to approve
        return;
      }

      const verb = choice ? 'APPROVED' : 'REFUSED';
      console.log(`  [YOU] ${verb}`);
      decisions.push(`${verb} ${JSON.stringify(entry.request ?? {})}`.slice(0, 90));
      approval.settle(entry.id, { approved: choice, scope: 'once' });
    }
  }, 250);
  return () => clearInterval(timer);
}

const browser = await firefox.launch({ headless: !HEADED, executablePath: BIN });
const context = await browser.newContext();

console.log('installing the gate...');
const registered = gate.installOnContext(context, { userId: 'demo' });
if (!registered) {
  console.error('gate FAILED to install -- refusing to run, that is the fail-closed path');
  process.exit(3);
}
console.log('gate installed.\n');

const page = await context.newPage();
await page.goto(url, { waitUntil: 'load' });
const decisions = [];
const stopPrompt = startApprovalPrompt(page, decisions);
console.log('page loaded. window should be open.\n');

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const step = (n, t) => console.log(`\n===== ${n}. ${t} ${'='.repeat(Math.max(0, 46 - t.length))}`);

// --- 1. browse: must be uneventful
step(1, 'BROWSE - GETs only, should sail through');
page.on('pageerror', e => console.log('  [PAGE ERROR]', e.message.split('\n')[0]));
await page.fill('#q', 'widget');
await page.click('button:has-text("Search")');
await pause(2000);
console.log('  in-page log says:', JSON.stringify(await page.locator('#log').innerText()));
console.log(`  server saw: ${JSON.stringify(seen)}`);
console.log('  ^ GET /search present means browsing is unblocked. That is the latency case.');

await page.locator('#add').dispatchEvent('click');
// Stu found this by doing exactly this: approve, then press it again. Repeat it
// every run so the demo keeps testing the thing it was built to catch.
console.log('  (pressing Add to bag a SECOND time -- must ask again, not slip through)');
await page.locator('#add').dispatchEvent('click');
// The approval dialog is a fixed overlay, so Playwright's actionability check
// refuses to click through it. Trigger the action in-page instead, then let the
// human answer the dialog that appears.
console.log('  (a LODESTAR dialog should be covering the page right now)');
await pause(1000);
console.log('  dialog visible:', await page.locator('text=Irreversible action requested').count() > 0);
// Wait for a real answer rather than a fixed sleep: an undecided approval and a
// refusal look identical from outside.
const t0 = Date.now();
while (decisions.length < 1 && Date.now() - t0 < 120000) await pause(500);
await pause(1500);
console.log(`  after the repeat: server saw ${JSON.stringify(seen)}`);
console.log('  ^ two POST /cart entries is CORRECT now: the second one was asked about.');
console.log('  in-page log says:', JSON.stringify(await page.locator('#log').innerText()));
console.log(`  server saw: ${JSON.stringify(seen)}`);
console.log('  ^ POST /cart arrives ONLY if you approved the dialog.');

// --- 2. pay: the one that matters
step(2, 'PAY - the irreversible one');
console.log('  A dialog will appear in the browser window. Read it before deciding.');
console.log('  This one carries a CARD NUMBER. Refusing it is the point.');
await page.locator('#pay').dispatchEvent('click');

// Wait for a real decision, not a fixed sleep. An undecided approval and a
// refusal look identical from outside, so the run must not end until you answer.
const t1 = Date.now();
while (decisions.length < 3 && Date.now() - t1 < 180000) await pause(500);
if (decisions.length < 2) {
  console.log('  !! no answer given within 120s -- this run proves nothing about the gate');
}

console.log('\n===== RESULT ' + '='.repeat(42));
console.log('server received :', JSON.stringify(seen));
console.log('');

// Distinguish "the gate held it" from "the run ended before anyone decided".
// Only the first is a result. Conflating them is how you get a green that means
// nothing -- an undecided approval and a refusal look identical from outside.
const decided = decisions.length;
const cartPosts = seen.filter(x => x === 'POST /cart').length;
console.log(`  POST /cart count: ${cartPosts}`);
if (seen.includes('POST /pay')) {
  console.log(`VERDICT: the payment LANDED after you ${decisions[decisions.length - 1]}.`);
  console.log('  The gate asked, a human answered, and the answer was carried out.');
  console.log('  That is the product: not a refusal, a decision.');
} else if (decided < 2) {
  console.log('VERDICT: INCONCLUSIVE. The payment did not land, but nobody decided.');
  console.log(`  only ${decided} approval(s) answered; the run ended first.`);
  console.log('  This is NOT evidence the gate held anything. Re-run and answer both');
  console.log('  dialogs to get a result.');
} else {
  console.log(`VERDICT: you REFUSED the payment and the gate held it.`);
  console.log('  The card number never left the machine. That is the product.');
}
console.log(`\n  approvals answered: ${decided}`);
console.log(`  ${decisions.join(', ') || '(none)'}`);

await pause(2000);
stopPrompt();
await browser.close();
srv.close();

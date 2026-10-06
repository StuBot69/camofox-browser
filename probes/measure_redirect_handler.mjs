// PRECISE version of the redirect measurement.
//
// The first pass conflated "gate.stats.allowed + refused" with handler
// invocations, and allowedSilent counts GETs, so that number could not answer
// the question that matters. The question is narrow and binary:
//
//   does context.route()'s HANDLER get invoked for the redirect's second hop?
//
// Answered here by tapping the gate's own observation hook, which fires once
// per handler entry, before any policy branch. If hop2 does not appear there,
// then decide()/grantCovers() were never consulted for the request that
// actually carried the card number.
//
// Run: CAMOUFOX_BIN=... node measure_redirect_handler.mjs

import http from 'node:http';
import { firefox } from 'playwright-core';
import { createApprovalSurface } from '../plugins/egress-gate/lib/approval.js';
import { createAuditLog } from '../plugins/egress-gate/lib/audit.js';
import { createEgressGate } from '../plugins/egress-gate/lib/gate.js';

const SERVER = [];
const HANDLER = [];
const EVENTS = [];

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        SERVER.push({ method: req.method, path: req.url, body });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><meta charset=utf-8><title>probe</title>
<button id="jsfetch" onclick="fetch('/r307',{method:'POST',body:'card=4111111111111111'})">Pay</button>
<form method="post" action="/r307"><input name="card" value="4111111111111111"><button id="postform" type="submit">Pay by form</button></form>`);
        } else if (req.url === '/r307') {
          res.writeHead(307, { Location: '/hop2' });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/json' });
          res.end('{"ok":true}');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

const BIN = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
if (!BIN) { console.error('set CAMOUFOX_BIN'); process.exit(2); }

const { srv, url } = await startServer();
const browser = await firefox.launch({ headless: true, executablePath: BIN });
const context = await browser.newContext();

const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 3000 });
const audit = createAuditLog();
const gate = createEgressGate({ approval, audit });

// The handler-entry tap. One line, inside the real handler, nothing simulated.
gate.setObserver(({ method, url: u }) => HANDLER.push({ method, path: u.replace(url, '/') }));

const page = await context.newPage();
context.on('request', (r) => EVENTS.push({ method: r.method(), path: r.url().replace(url, '/') }));
await gate.installOnContext(context, { userId: 'u', sessionKey: 's' });

await page.goto(url, { waitUntil: 'load' });

async function trial(label, trigger, grantFirst) {
  SERVER.length = 0; HANDLER.length = 0; EVENTS.length = 0;

  if (grantFirst) {
    // Grant POST /r307 for the session, the way a human answering the approval
    // surface would. grantKey is method+url, so /hop2 is NOT covered by it.
    const p = approval.ask({ method: 'POST', url: `${url}r307`, sessionKey: 's', userId: 'u' });
    const [rec] = approval.listPending();
    approval.settle(rec.id, { approved: true, scope: 'session' });
    await p;
  }

  page.click(trigger).catch(() => {});
  await page.waitForTimeout(1500);

  const mut = (rows) => rows.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
  const landed = mut(SERVER), handled = mut(HANDLER), evented = mut(EVENTS);
  const rows = audit.list().map((a) => `${a.method} ${a.url.replace(url, '/')}=${a.decision}`);

  console.log(`\n${label}`);
  console.log(`  server received   : ${landed.map((r) => `${r.method} ${r.path}`).join(', ') || '(none)'}`);
  console.log(`  handler invoked   : ${handled.map((r) => `${r.method} ${r.path}`).join(', ') || '(none)'}`);
  console.log(`  playwright event  : ${evented.map((r) => `${r.method} ${r.path}`).join(', ') || '(none)'}`);
  console.log(`  audit rows        : ${rows.join(' | ') || '(none)'}`);
  const noDecision = landed.filter((r) => !handled.some((h) => h.path === r.path));
  for (const r of noDecision) console.log(`  >> BODY LANDED WITHOUT A HANDLER INVOCATION: ${r.method} ${r.path} body=${JSON.stringify(r.body)}`);
  console.log(`  VERDICT           : ${noDecision.length ? `BYPASS x${noDecision.length}` : 'gated'}`);

  audit.record.length; // keep the reference honest; list() already reads live
  return noDecision.length;
}

const a = await trial('A  fetch POST, 307 -> /hop2, session grant for /r307', '#jsfetch', true);
const b = await trial('B  navigating <form method=post>, 307 -> /hop2', '#postform', true);

console.log(`\nRESULT  fetch-form bypasses: fetch=${a} form=${b}`);
console.log('Reading: a non-zero value means POST /hop2 left the machine with the');
console.log('card body and no gate decision of any kind. grantCovers() was never called for it.');

await browser.close();
srv.close();
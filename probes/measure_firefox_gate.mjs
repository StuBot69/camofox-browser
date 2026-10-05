// MEASUREMENT: does page.route() actually intercept in playwright-core's FIREFOX?
//
// My earlier proof used Chromium via the Python API. The real Hermes browser is
// Camoufox = playwright-core 1.59.1 driving FIREFOX, and route interception has
// historically been the weak spot there. A Chromium result does not transfer,
// so this re-measures on the engine that actually runs.
//
// The question is binary and worth measuring rather than assuming:
//   Can we SEE a request a click causes, and ABORT it before it leaves?
//
// If yes: the deterministic gate drops into the real browser_click path.
// If no: the wiring question has a different answer and we should say so.

import http from 'node:http';
import { firefox } from 'playwright-core';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SEEN = [];

const PAGE = `<!doctype html><meta charset=utf-8><title>mock</title>
<a id="getlink" href="/ping?id=1">Continue</a>
<form method="post" action="/charge">
  <input name="amount" value="500">
  <button id="postform" type="submit">Pay now</button>
</form>
<button id="jsfetch" onclick="fetch('/charge',{method:'POST',body:'amount=500'})">Cancel subscription</button>
`;

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        SEEN.push({ method: req.method, path: req.url, body });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(PAGE);
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function runCase(url, target, gate) {
  const before = SEEN.length;
  const seenByGate = [];
  // Use the REAL engine the Hermes browser runs: the Camoufox binary, driven
  // by playwright-core. Pointing at stock Firefox would test an engine that
  // never runs here, and playwright-core's own firefox build is not installed.
  const browser = await firefox.launch({
    headless: true,
    executablePath: process.env.CAMOUFOX_BIN,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.route('**/*', async (route, request) => {
    const entry = { method: request.method(), url: request.url() };
    if (gate && MUTATING.has(request.method())) {
      entry.verdict = 'REFUSED';
      seenByGate.push(entry);
      await route.abort();
    } else {
      entry.verdict = 'allowed';
      seenByGate.push(entry);
      await route.continue();
    }
  });

  await page.goto(url, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.click(target);
  const ms = Date.now() - t0;
  await page.waitForTimeout(600);
  await browser.close();

  // TWO lists, and the distinction is load-bearing.
  //
  // `arrived` is EVERY request the server actually received. `landed` is only
  // the mutating subset. The previous version returned `landed` alone, which
  // made the "harmless GET passes" control a tautology: `landed` is filtered to
  // POST/PUT/PATCH/DELETE, a GET can never satisfy that filter, so
  // `landed.length === 0` was true no matter what the route handler did. A
  // handler that aborted EVERY request would have scored PROVEN.
  //
  // A control has to be able to come back red. Asserting on the ABSENCE of a
  // category the trigger cannot produce cannot.
  const arrived = SEEN.slice(before).filter((e) => e.path !== '/');
  const landed = arrived.filter((e) => MUTATING.has(e.method));
  return { seenByGate, arrived, landed, ms };
}

const { srv, port } = await startServer();
const url = `http://127.0.0.1:${port}/`;
console.log(`mock: ${url}`);
console.log(`engine: playwright-core FIREFOX driving ${process.env.CAMOUFOX_BIN}\n`);

const results = {};
for (const [name, target] of [['getlink', '#getlink'], ['postform', '#postform'], ['jsfetch', '#jsfetch']]) {
  for (const gate of [false, true]) {
    const label = `${name} gate=${gate ? 'ON' : 'OFF'}`;
    const r = await runCase(url, target, gate);
    results[label] = r;
    console.log(label);
    for (const e of r.seenByGate) {
      if (e.method !== 'GET' || e.url.includes('/charge')) {
        console.log(`    gate saw : ${e.method} ${e.url.replace(url, '/')} -> ${e.verdict}`);
      }
    }
    console.log(`    effect landed: ${r.landed.length ? 'YES' : 'no'}`);
    console.log(`    click: ${r.ms}ms\n`);
  }
}

console.log('='.repeat(66));
const jsOff = results['jsfetch gate=OFF'];
const jsOn = results['jsfetch gate=ON'];
const postOff = results['postform gate=OFF'];
const postOn = results['postform gate=ON'];
const getOff = results['getlink gate=OFF'];
const getOn = results['getlink gate=ON'];

// Every check below goes through say(), so a falsified claim is RECORDED and
// the process exits non-zero. A check that only prints cannot fail the build,
// which is the failure mode this file previously had.
const failures = [];
const say = (ok, label) => {
  if (!ok) failures.push(label);
  return ok ? 'PROVEN' : 'NOT PROVEN';
};

// c1: the route handler fires at all when the gate is OFF.
const c1 = jsOff.seenByGate.some((e) => e.method === 'POST');

// c2: the gate stops the mutating effect. The gate=OFF arm is what makes this
// falsifiable -- without it, a handler that silently swallowed every request
// would also produce landed.length === 0 and score PROVEN. The delivery path
// has to be shown working before "nothing arrived" means anything.
const c2offJs = jsOff.landed.length > 0;
const c2offPost = postOff.landed.length > 0;
const c2 = c2offJs && c2offPost && jsOn.landed.length === 0 && postOn.landed.length === 0;

// c3: a harmless GET is allowed through -- asserted as ARRIVAL, not absence.
// Asserting `landed.length === 0` here was vacuous: landed only ever contains
// mutating methods, so a GET could never appear in it and the check was
// unconditionally true. The GET must be positively observed at the server.
const c3off = getOff.arrived.some((e) => e.method === 'GET' && e.path.startsWith('/ping'));
const c3on = getOn.arrived.some((e) => e.method === 'GET' && e.path.startsWith('/ping'));
const c3 = c3off && c3on;

console.log(`0a. POST reaches the server with the gate OFF : ${say(c2offJs && c2offPost, 'gate=OFF delivery (control)')}`);
console.log(`0b. GET  reaches the server with the gate OFF : ${say(c3off, 'GET delivery with gate OFF')}`);
console.log(`1.  Click effect observable before it leaves  : ${say(c1, 'route handler fires')}`);
console.log(`2.  Veto stops the mutating effect            : ${say(c2, 'veto stops mutating traffic')}`);
console.log(`3.  Harmless GET passes                      : ${say(c3, 'harmless GET arrives')}`);

const allOk = [c1, c2, c3, c2offJs, c2offPost, c3off, c3on].every(Boolean);
console.log(`\nFIREFOX verdict: ${allOk
  ? 'the deterministic gate DROPS INTO the real browser path.'
  : 'route interception does NOT hold on Firefox. The Chromium result does not transfer.'}`);

if (failures.length) {
  console.log(`\nFAILED (${failures.length}): ${failures.join(' | ')}`);
  console.log('A control that cannot come back red proves nothing.');
  srv.close();
  process.exitCode = 1;
} else {
  console.log('\nAll controls falsifiable and green.');
  srv.close();
}

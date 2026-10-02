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

  const landed = SEEN.slice(before).filter((e) => MUTATING.has(e.method));
  return { seenByGate, landed, ms };
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
const postOn = results['postform gate=ON'];
const getOn = results['getlink gate=ON'];

const c1 = jsOff.seenByGate.some((e) => e.method === 'POST');
const c2 = jsOn.landed.length === 0 && postOn.landed.length === 0;
const c3 = getOn.landed.length === 0;

console.log(`1. Click effect observable before it leaves : ${c1 ? 'PROVEN' : 'NOT PROVEN'}`);
console.log(`2. Veto stops the mutating effect           : ${c2 ? 'PROVEN' : 'NOT PROVEN'}`);
console.log(`3. Harmless GET passes                     : ${c3 ? 'PROVEN' : 'NOT PROVEN'}`);
console.log(`\nFIREFOX verdict: ${c1 && c2 && c3
  ? 'the deterministic gate DROPS INTO the real browser path.'
  : 'route interception does NOT hold on Firefox. The Chromium result does not transfer.'}`);
srv.close();

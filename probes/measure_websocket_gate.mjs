// Does routeWebSocket() actually intercept on Camoufox/Firefox in THIS repo?
//
// The report says WebSocket handshakes are invisible to context.route() -- the
// server got GET /ws with zero handler invocations, which is different from a
// GET the gate allowed. If routeWebSocket intercepts here, it is a small closure
// of a real hole. If it silently does nothing on Firefox, wiring it would be
// the exact failure mode this whole task is about: a second layer that looks
// armed and is not.
//
// The check is the strict one. "No crash" is not evidence. The test is: does
// the HANDLER fire, and can it stop the connection from reaching the server?
//
// Run: CAMOUFOX_BIN=... node measure_websocket_gate.mjs

import http from 'node:http';
import { firefox } from 'playwright-core';
import { createEgressGate } from '../plugins/egress-gate/lib/gate.js';
import { createApprovalSurface } from '../plugins/egress-gate/lib/approval.js';
import { createAuditLog } from '../plugins/egress-gate/lib/audit.js';

const SERVER_HITS = [];
const HANDLER_HITS = [];

const srv = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><button id=go>open socket</button>');
    return;
  }
  // Anything that arrives here with Upgrade: websocket reached the server.
  SERVER_HITS.push({ url: req.url, upgrade: req.headers.upgrade ?? null });
  res.writeHead(400);
  res.end('upgrade required');
});

srv.on('upgrade', (req, socket) => {
  SERVER_HITS.push({ url: req.url, upgrade: 'websocket' });
  socket.destroy();
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const url = `http://127.0.0.1:${PORT}/`;

const BIN = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
if (!BIN) { console.error('set CAMOUFOX_BIN'); process.exit(2); }

const browser = await firefox.launch({ headless: true, executablePath: BIN });
const context = await browser.newContext();
const gate = createEgressGate({
  approval: createApprovalSurface({ mode: 'passive' }),
  audit: createAuditLog(),
});
gate.setObserver(({ method, url: u }) => HANDLER_HITS.push({ method, path: u.replace(url, '/') }));

await gate.installOnContext(context, { userId: 'u', sessionKey: 's' });

// Does routeWebSocket exist, and does registering one throw?
let registered = false;
let routeWsError = null;
try {
  await context.routeWebSocket('**/*', (ws) => {
    HANDLER_HITS.push({ method: 'WEBSOCKET', path: String(ws.url()).replace(url.replace('http', 'ws'), '/') });
    ws.close({ code: 1008, reason: 'egress gate refused' });
  });
  registered = true;
} catch (err) {
  routeWsError = err?.message ?? String(err);
}

const page = await context.newPage();
await page.goto(url, { waitUntil: 'load' });
// Driven from evaluate rather than a click handler: a WebSocket opened inside a
// click callback raced the measurement's wait and produced a false "did not
// intercept" reading on the first pass of this script. The claim under test is
// about routeWebSocket, so the trigger must not be a second moving part.
const result = await page.evaluate(
  (u) =>
    new Promise((resolve) => {
      const ws = new WebSocket(u);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('error');
      ws.onclose = (e) => resolve(`close:${e.code}`);
      setTimeout(() => resolve('timeout'), 2500);
    }),
  `${url.replace('http', 'ws')}/ws`,
);

console.log('\nWebSocket interception on Camoufox/Firefox, playwright-core 1.59.1');
console.log(`  context.routeWebSocket exists  : ${typeof context.routeWebSocket === 'function'}`);
console.log(`  registration succeeded         : ${registered}${routeWsError ? ` (threw: ${routeWsError})` : ''}`);
console.log(`  ws handler invoked             : ${HANDLER_HITS.filter((h) => h.method === 'WEBSOCKET').length}`);
console.log(`  http route handler invoked     : ${HANDLER_HITS.filter((h) => h.method !== 'WEBSOCKET').length}`);
console.log(`  server saw /ws                 : ${SERVER_HITS.filter((h) => h.url === '/ws').length}`);
console.log(`  browser WebSocket state        : ${result}`);
console.log(`\n  VERDICT: ${
  HANDLER_HITS.some((h) => h.method === 'WEBSOCKET') && !SERVER_HITS.some((h) => h.url === '/ws')
    ? 'routeWebSocket WORKS here -- wireable'
    : registered
      ? 'routeWebSocket registered but did NOT intercept -- wiring it would be a second silent-disarmed layer'
      : 'routeWebSocket unavailable on this engine'
}`);

await browser.close();
srv.close();
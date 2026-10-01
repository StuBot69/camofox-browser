// MEASUREMENT: does context.route() hold on Camoufox/Firefox, and what does it cost?
//
// The gate is installed on the BrowserContext rather than on each page, so the
// coverage claim rests on three assumptions that nobody should take on trust:
//   A. context.route() intercepts at all on this engine (page.route did; the
//      owner's measurement proved page.route, NOT context.route).
//   B. it covers pages created AFTER the route is installed
//   C. it covers popups, which never pass through newPage()
//
// And the brief asks for a measured cost, not an assertion. So this measures
// per-click latency with the gate on and off, and re-checks the static-asset
// assumption: "a <script> or <img> load is GET, so it passes".
//
// Run: CAMOUFOX_BIN=... node measure_context_gate.mjs

import http from 'node:http';
import { firefox } from 'playwright-core';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SEEN = [];
const SAMPLES = [];

const PAGE = `<!doctype html><meta charset=utf-8><title>mock</title>
<a id="getlink" href="/ping?id=1">Continue</a>
<form method="post" action="/charge">
  <input name="amount" value="500">
  <button id="postform" type="submit">Pay now</button>
</form>
<button id="jsfetch" onclick="fetch('/charge',{method:'POST',body:'amount=500'})">Cancel subscription</button>
<button id="openpop" onclick="window.open('/popup','_blank')">open popup</button>
<img id="theimg" src="/pixel.gif" width="1" height="1">
`;

const POPUP = `<!doctype html><meta charset=utf-8><title>popup</title>
<button id="popupcharge" onclick="fetch('/charge',{method:'POST',body:'from=popup'})">Confirm</button>
`;

// A page whose ASSETS mutate. If the brief's assumption ("an <img> or <script>
// load is GET") holds, neither of these trips the gate. Measure, don't assume.
const ASSET_PAGE = `<!doctype html><meta charset=utf-8><title>assets</title>
<img id="imgpost" src="/imgpost" width="1" height="1">
<script src="/scriptpost.js"></script>
<script>
fetch('/fetchpost',{method:'POST',body:'inline=1'});
fetch('/fetchput',{method:'PUT',body:'inline=1'});
</script>
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
        } else if (req.url === '/assets') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(ASSET_PAGE);
        } else if (req.url === '/popup') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(POPUP);
        } else if (req.url === '/scriptpost.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`fetch('/jsfetchpost',{method:'POST',body:'from=script'});`);
        } else if (req.url === '/pixel.gif') {
          res.writeHead(200, { 'Content-Type': 'image/gif' });
          res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function gateHandler(seen) {
  return async (route, request) => {
    const entry = { method: request.method(), url: request.url(), verdict: 'allowed' };
    if (MUTATING.has(request.method())) {
      entry.verdict = 'REFUSED';
      seen.push(entry);
      await route.abort();
      return;
    }
    seen.push(entry);
    await route.continue();
  };
}

async function launch() {
  return firefox.launch({ headless: true, executablePath: process.env.CAMOUFOX_BIN });
}

const { srv, port } = await startServer();
const url = `http://127.0.0.1:${port}/`;
console.log(`mock: ${url}`);
console.log(`engine: playwright-core FIREFOX driving ${process.env.CAMOUFOX_BIN}\n`);

// ---------------------------------------------------------------- A and B
{
  const browser = await launch();
  const context = await browser.newContext();
  const seenByGate = [];
  // Install on the CONTEXT, then create the page afterwards. This is the order
  // the plugin uses, and it is the assumption that matters.
  await context.route('**/*', gateHandler(seenByGate));
  const page = await context.newPage();
  const before = SEEN.length;

  await page.goto(url, { waitUntil: 'load' });
  await page.click('#jsfetch');
  await page.waitForTimeout(700);
  const landed = SEEN.slice(before).filter((e) => MUTATING.has(e.method));

  console.log('A/B  context.route installed BEFORE newPage()');
  console.log(`    gate saw the JS-fetch POST : ${seenByGate.some((e) => e.url.includes('/charge')) ? 'YES' : 'no'}`);
  console.log(`    effect landed              : ${landed.length ? 'YES' : 'no'}`);
  console.log(`    A holds (context.route works): ${seenByGate.some((e) => e.url.includes('/charge')) ? 'PROVEN' : 'NOT PROVEN'}`);
  await browser.close();
}

// ---------------------------------------------------------------- C popup
{
  const browser = await launch();
  const context = await browser.newContext();
  const seenByGate = [];
  await context.route('**/*', gateHandler(seenByGate));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const before = SEEN.length;

  await page.click('#openpop');
  const popup = await page.waitForEvent('popup', { timeout: 5000 });
  await popup.waitForLoadState('load');
  await popup.click('#popupcharge');
  await page.waitForTimeout(700);
  const landed = SEEN.slice(before).filter((e) => MUTATING.has(e.method));

  console.log('\nC    popup that never passed through newPage()');
  console.log(`    gate saw the popup POST   : ${seenByGate.some((e) => e.url.includes('/charge')) ? 'YES' : 'no'}`);
  console.log(`    effect landed             : ${landed.length ? 'YES' : 'no'}`);
  console.log(`    C holds (popups covered)  : ${landed.length === 0 && seenByGate.some((e) => e.url.includes('/charge')) ? 'PROVEN' : 'NOT PROVEN'}`);
  await browser.close();
}

// ---------------------------------------------------------------- assets
{
  const browser = await launch();
  const context = await browser.newContext();
  const seenByGate = [];
  await context.route('**/*', gateHandler(seenByGate));
  const page = await context.newPage();
  const before = SEEN.length;
  await page.goto(`${url}assets`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const landed = SEEN.slice(before);

  console.log('\nASSETS  does anything static use a mutating method?');
  const saw = (frag) => seenByGate.filter((e) => e.url.includes(frag));
  for (const [label, frag] of [
    ['image  <img src=/imgpost>         ', '/imgpost'],
    ['script <script src=/scriptpost.js> ', '/jsfetchpost'],
    ['inline fetch POST                  ', '/fetchpost'],
    ['inline fetch PUT                   ', '/fetchput'],
  ]) {
    const hits = saw(frag);
    const verbs = [...new Set(hits.map((e) => e.method))].join(',') || 'not seen';
    const verdicts = [...new Set(hits.map((e) => e.verdict))].join(',') || '-';
    console.log(`    ${label} methods=${verbs.padEnd(10)} verdicts=${verdicts}`);
  }
  console.log(`    mutating requests that landed        : ${landed.filter((e) => MUTATING.has(e.method)).length}`);
  await browser.close();
}

// ------------------------------------------- what does a click cost while gated?
// The gate holds a request open for up to timeoutMs waiting for a human. The
// question that decides whether APPROVAL_HEADROOM_MS is even needed: does
// page.click() block for that wait, or does it resolve and leave the page's
// fetch pending? If it resolves immediately, the click handler's action budget
// is NOT consumed and there is no tab_timeout to avoid.
{
  const browser = await launch();
  const context = await browser.newContext();
  let released = null;
  await context.route('**/*', async (route, request) => {
    if (MUTATING.has(request.method())) {
      // Hold the request the way a 20s human approval would.
      await new Promise((resolve) => { released = resolve; });
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });

  const t0 = Date.now();
  await page.click('#jsfetch');
  const clickMs = Date.now() - t0;
  console.log('\nWAIT    a click while the gate holds its request for a human');
  console.log(`    page.click() resolved after      : ${clickMs}ms`);
  console.log(`    gate still holding the request   : ${released !== null ? 'YES' : 'no'}`);
  console.log(`    -> the action budget is          : ${clickMs < 1000 ? 'NOT consumed by the wait' : 'consumed by the wait'}`);
  if (released) released();
  await page.waitForTimeout(200);
  await browser.close();
}

// ---------------------------------------------------------------- latency
for (const target of ['#jsfetch', '#postform']) {
  for (const gate of [false, true]) {
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const browser = await launch();
      const context = await browser.newContext();
      if (gate) await context.route('**/*', gateHandler([]));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load' });
      const t0 = Date.now();
      await page.click(target);
      await page.waitForTimeout(250);
      runs.push(Date.now() - t0);
      await browser.close();
    }
    runs.sort((a, b) => a - b);
    SAMPLES.push({ target, gate, min: runs[0], median: runs[2], max: runs[4] });
  }
}

console.log('\nLATENCY  per click, headless, local mock page (ms)');
console.log('    target      gate   min   median   max');
for (const s of SAMPLES) {
  console.log(`    ${s.target.padEnd(10)} ${String(s.gate).padEnd(6)} ${String(s.min).padStart(4)} ${String(s.median).padStart(7)} ${String(s.max).padStart(5)}`);
}
for (const target of ['#jsfetch', '#postform']) {
  const off = SAMPLES.find((s) => s.target === target && !s.gate);
  const on = SAMPLES.find((s) => s.target === target && s.gate);
  console.log(`    ${target} median cost of the gate: ${on.median - off.median}ms`);
}

// ------------------------------------------- and the form-submit case
// The JS-fetch measurement above resolved in 110ms because fetch() is
// fire-and-forget: the click does not wait for it. A form submit is NOT
// fire-and-forget -- the navigation IS the click's completion. If the gate holds
// that POST, page.click() may block for the whole human wait. That is the case
// the action budget and APPROVAL_HEADROOM_MS were reasoned about, so measure it
// rather than assume it.
{
  const browser = await launch();
  const context = await browser.newContext();
  let released = null;
  await context.route('**/*', async (route, request) => {
    if (MUTATING.has(request.method())) {
      await new Promise((resolve) => { released = resolve; });
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });

  const t0 = Date.now();
  let clickError = null;
  await Promise.race([
    page.click('#postform').catch((e) => { clickError = e; }),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  const clickMs = Date.now() - t0;
  console.log('\nWAIT    a FORM SUBMIT while the gate holds its POST for a human');
  console.log(`    page.click() settled after       : ${clickMs}ms (8s cap)`);
  console.log(`    errored                          : ${clickError ? clickError.message.split('\n')[0].slice(0, 80) : 'no'}`);
  console.log(`    gate still holding the request   : ${released !== null ? 'YES' : 'no'}`);
  console.log(`    -> the action budget is          : ${clickMs > 1000 ? 'CONSUMED by the wait' : 'not consumed by the wait'}`);
  if (released) released();
  await page.waitForTimeout(200);
  await browser.close();
}
srv.close();

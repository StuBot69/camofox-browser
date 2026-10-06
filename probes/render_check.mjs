// Renders the REAL page out of demos/shop-demo.mjs and checks the harness works
// before a human is asked to sit through it.
//
// This is a probe, not a test: it drives a live browser against the page the demo
// actually serves. It exists because a rewrite once shipped an escaped \${CARD}
// that only a render could distinguish from a correct ${CARD}.
//
// fetch is stubbed so no approval dialogs and no gate are involved -- the
// question here is "does the page's own harness work", not "does the gate".
//
// THE ISOLATED-WORLD TRAP, which this probe exists to respect:
// this engine is anti-detection, so page.evaluate() runs in an ISOLATED WORLD
// that cannot see page globals. A page script that sets window.foo works fine --
// the DOM proves it -- yet page.evaluate(() => window.foo) returns undefined.
// Measured on beta.31: page wrote "DOM:inline-ran" and "mainworld:string:
// inline-ran" into the DOM while the driver read typeof window.__x === undefined.
// Anything the driver needs to read back from the page must therefore go through
// the DOM, which is shared between the two worlds.
//
// Usage:
//   export CAMOUFOX_BIN=.../Camoufox.app/Contents/MacOS/camoufox
//   node probes/render_check.mjs

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { firefox } from 'playwright-core';

const BIN = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
if (!BIN) { console.error('set CAMOUFOX_BIN'); process.exit(2); }

const failures = [];
const say = (ok, label, extra = '') => {
  if (!ok) failures.push(label + (extra ? ' -- ' + extra : ''));
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// Pull the real PAGE template literal out of the demo source. A retyped copy
// would prove nothing about the file that ships.
//
// Two traps this walk avoids, both of which return an EMPTY template and so
// render a blank page for no visible reason:
//   - slicing from `start + 'const PAGE = '` leaves the opening backtick at
//     body[0], so a walk starting at k=0 finds THAT one at offset 0
//   - searching for '\n`;' misses the real terminator, which is `</script>`;`
//     with the closing tag and the backtick on the same line
const src = readFileSync('demos/shop-demo.mjs', 'utf8');
const start = src.indexOf('const PAGE = `');
if (start === -1) { console.error('could not find `const PAGE = \``'); process.exit(1); }
const body = src.slice(start + 'const PAGE = '.length + 1);
let end = -1;
for (let k = 0; k < body.length; k++) {
  if (body[k] === '\\') { k++; continue; }
  if (body[k] === '`') { end = k; break; }
}
if (end === -1) { console.error('could not find the closing backtick of PAGE'); process.exit(1); }

const CARD = '4242424242424242';
let PAGE;
try {
  PAGE = new Function('CARD', 'return `' + body.slice(0, end) + '`;')(CARD);
} catch (e) {
  console.error('the PAGE template does not evaluate:', e.message);
  process.exit(1);
}
say(PAGE.includes('STEP 1'), 'the extracted template is non-empty and complete',
    `${PAGE.length} chars`);

// Serve over real http, exactly as the demo's own server does. setContent is
// deliberately not used: it is a different code path and would not prove the
// demo works.
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const browser = await firefox.launch({ headless: true, executablePath: BIN });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(300);

// --- 1. the controls the human is told to press actually exist --------------
for (const id of ['add', 'add2', 'pay', 'search']) {
  say(await page.locator('#' + id).count() > 0, `button #${id} is on the page`);
}

// --- 2. the page's own script ran ------------------------------------------
// Proof comes from the DOM, which the page itself wrote. window.__lodestar is
// NOT used here: it is genuinely set, but the driver's isolated world is blind
// to it, so asserting on it would be a false failure.
const initial = await page.locator('#t').innerText();
say(/STEP 1/i.test(initial), 'the page script ran (transcript rendered)',
    JSON.stringify(initial.slice(0, 46)));

// --- 3. clicking a button publishes the step across the world boundary ------
await page.evaluate(() => {
  window.fetch = async () => ({ status: 200, text: () => Promise.resolve('{"stub":1}') });
});

for (const [id, step] of Object.entries({ add: 1, add2: 2, pay: 3 })) {
  await page.locator('#' + id).click();
  await page.waitForTimeout(250);
  const attr = await page.locator('body').getAttribute('data-step');
  say(Number(attr) === step,
      `clicking #${id} publishes data-step="${step}" for the driver`,
      `got ${attr}`);
}

// --- 4. the transcript accumulated the presses -----------------------------
const lines = (await page.locator('#t').innerText()).split('\n').filter(Boolean).length;
say(lines >= 3, 'transcript recorded every press', `${lines} lines`);

// --- 5. the card value really is in the page, not an escaped literal -------
say(PAGE.includes(CARD), 'the card number is present in the served HTML');
say(!PAGE.includes('\\${CARD}'), 'no escaped \\${CARD} literal in the page',
    'an escaped interpolation would send the text ${CARD} as the card number');

// --- 6. no page-level errors ----------------------------------------------
say(pageErrors.length === 0, 'the page threw no errors',
    pageErrors.length ? pageErrors.join(' | ') : '');

console.log('\n--- transcript as the human sees it ---');
console.log(await page.locator('#t').innerText());

await browser.close();
srv.close();

console.log('');
if (failures.length) {
  console.log(`VERDICT: BROKEN -- ${failures.length} check(s) failed:`);
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('VERDICT: OK -- the page renders, the steps track, and the transcript fills.');
process.exit(0);
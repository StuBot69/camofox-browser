// Why this exists: the demo's pay step silently issued NO request at all, so the
// gate never asked about /pay and the run reported INCONCLUSIVE. The cause was a
// bare `CARD` inside the PAGE template literal -- a Node-scope identifier that is
// undefined inside the browser, so pay() threw a ReferenceError and its own
// try/catch swallowed it into a page message nobody reads.
//
// The lesson is not "typo". A demo that silently under-tests looks EXACTLY like a
// gate that is correctly asking a human: both print INCONCLUSIVE. So this check
// makes the under-test loud and exits non-zero.
//
// It renders the REAL PAGE template out of demos/shop-demo.mjs. A retyped copy
// proves nothing about the file that actually ships.
//
// Usage:  node probes/check_demo_pay_path.mjs     (no browser needed)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const demoPath = join(here, '..', 'demos', 'shop-demo.mjs');
const src = readFileSync(demoPath, 'utf8');

const failures = [];
// Every check MUST go through here. An earlier version of this file printed FAIL
// twice and still exited 0 with a happy VERDICT, because it only ever pushed to
// a list nothing read. `say()` returning a boolean is the whole guard.
const say = (ok, label, extra = '') => {
  if (!ok) failures.push(label + (extra ? ' -- ' + extra : ''));
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  return ok;
};

// Extract a real template literal: find the opening backtick after `decl`, then
// walk to the matching unescaped backtick. indexOf('`;') is wrong because the
// body contains backticks and newlines of its own.
function extractTemplateLiteral(source, decl) {
  const declAt = source.indexOf(decl);
  if (declAt === -1) return null;
  const open = source.indexOf('`', declAt);
  if (open === -1) return null;
  let k = open + 1;
  while (k < source.length) {
    if (source[k] === '\\') { k += 2; continue; }
    if (source[k] === '`') return source.slice(open + 1, k);
    k++;
  }
  return null;
}

// --- 1. the page template must exist and be a template literal -------------
const raw = extractTemplateLiteral(src, 'const PAGE =');
say(raw !== null, 'PAGE is a template literal, so ${...} interpolates',
    raw === null ? 'could not find the closing backtick of `const PAGE = \``' : '');

const payLine = src.split('\n').find(l => l.includes("post('/pay'"));
say(!!payLine, 'pay() POSTs to /pay');

// Inside a template literal, ${CARD} interpolates and a bare CARD does not.
// `${CARD}` must therefore be read as ONE token -- matching /CARD/ alone matches
// both forms, which is why an earlier version of this check failed the fixed file.
if (payLine) {
  const bare = /(^|[^$\w])CARD\b/.test(payLine.replace(/\$\{CARD\}/g, ''));
  say(!bare, 'pay() passes CARD as ${CARD}, not a bare identifier',
      bare ? `line reads: ${payLine.trim()}` : '');
}

const CARD = '4242424242424242';

// --- 2. render the REAL template and check what the browser would get -------
let rendered = null;
if (raw !== null) {
  try {
    rendered = new Function('CARD', 'return `' + raw + '`;')(CARD);
    say(true, 'the real PAGE template evaluates');
  } catch (e) {
    say(false, 'the real PAGE template evaluates', e.message);
  }
}

if (rendered !== null) {
  say(rendered.includes(CARD),
      'the card number actually lands in the served HTML',
      'the page would throw ReferenceError in pay() and never POST');

  // Strip the interpolated value itself before scanning, or the literal card
  // number matches on its own digits.
  const leftover = rendered.replace(new RegExp(CARD, 'g'), '')
                           .replace(/\$\{CARD\}/g, '');

  // After interpolation nothing may still REFERENCE a bare CARD as code. The
  // scan strips comments and string literals first: prose that happens to say
  // "CARD" (like the comment explaining this very bug) is not a live reference,
  // and flagging it would make the check fail on its own documentation.
  const stripCommentsAndStrings = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  const codeOnly = stripCommentsAndStrings(leftover);
  say(!/(^|[^$\w])CARD\b/.test(codeOnly),
      'no unresolved bare CARD identifier survives in the page code',
      'a live reference to CARD remains after interpolation');
  say(rendered.includes("post('/pay'"), 'pay() still POSTs to /pay');
}

console.log('');
if (failures.length) {
  console.log(`VERDICT: BROKEN -- ${failures.length} check(s) failed:`);
  for (const f of failures) console.log('   - ' + f);
  console.log('A run of the demo will report INCONCLUSIVE and prove nothing.');
  process.exit(1);
}
console.log('VERDICT: OK -- the pay step WILL issue POST /pay, so the gate gets asked.');
process.exit(0);
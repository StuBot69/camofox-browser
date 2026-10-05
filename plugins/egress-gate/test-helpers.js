/**
 * Test helpers for the egress gate.
 *
 * The real-engine tests need a Camoufox binary. Resolving it is done here, once,
 * rather than by assuming an env var: the repo's own camoufox-js resolution path
 * throws on this machine (no version.json at the cache root), and a test that
 * silently degrades to fakes is exactly the kind of test that proves nothing.
 * So find the binary or say clearly that the real-engine tests were skipped.
 *
 * 5 Oct 2026 — THIS FILE WAS THE ROOT OF A SILENT COVERAGE LOSS, and the shape of
 * the fix matters more than the fix.
 *
 * WHAT WAS WRONG. `findCamoufoxBinary()` scanned two hardcoded roots for a
 * macOS-shaped path (`<root>/<version>/Camoufox.app/Contents/MacOS/camoufox`).
 * But camoufox-js@0.11.5 installs FLAT into `userCacheDir('camoufox')` with no
 * `browsers/official` segment, and names the Linux launcher `camoufox-bin`. So
 * on Linux CI the browser was DOWNLOADED, INSTALLED, and INVISIBLE to this
 * resolver. `armed.test.js:35`'s `BIN ? describe : describe.skip` therefore fired
 * and the suite reported GREEN having executed none of the real-engine coverage
 * of the project's headline 307/308 finding — silently, exit code 0, on every
 * run. Reproduced end-to-end by an auditor against a simulated Linux cache.
 *
 * WHY THE OLD SHAPE COULD NOT CATCH IT. It conflated three different failures
 * into one boolean, and returned null for all of them:
 *
 *   (i)  genuinely not downloaded        -> a legitimate skip
 *   (ii) present but not runnable (X_OK, arch) -> coverage being CLAIMED and not
 *                                               delivered — must not be a skip
 *   (iii) present at a path we don't know        -> the Linux case. MUST be loud
 *                                               everywhere, because nobody
 *                                               asked for absence.
 *
 * Treating (iii) as (i) is precisely how "the browser is installed but the
 * resolver cannot see it" became indistinguishable from "the developer has not
 * run the fetch command". So `resolveCamoufox()` below returns a MODE and a
 * REASON, never a bare null, and `describeCamoufoxEngine()` only skips for (i).
 *
 * ORDERING IS LOAD-BEARING: resolve candidates -> VERIFY BY LAUNCHING -> only
 * then decide skip-vs-fail. The loud gate is last on purpose. A gate placed
 * first fires on every future resolver bug (a layout change, a new cache
 * producer, a permissions regression) and converts "coverage quietly vanished"
 * into "red suite" — which is better, but trains people to re-run until green,
 * reintroducing the false green by another route. Verifying first means the gate
 * can only fire on genuine un-launchability.
 *
 * Note `existsSync` is NECESSARY BUT NOT SUFFICIENT — it says nothing about the
 * executable bit, which is why the repo's own postinstall.js checks X_OK
 * separately. Hence verify-by-launch rather than verify-by-stat.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
// NOTE: `expect` is deliberately NOT imported here. `expect.fail` does not exist
// on `@jest/globals` in jest 30.4.2 (measured: typeof expect.fail === 'undefined'),
// so the loud path throws a plain Error instead. See describeCamoufoxEngine.

const CACHE_ROOTS = [
  path.join(os.homedir(), 'Library/Caches/camoufox/browsers/official'),
  path.join(os.homedir(), '.cache/camoufox/browsers/official'),
];

function camoufoxBinaryIn(root) {
  if (!fs.existsSync(root)) return null;
  const versions = fs
    .readdirSync(root)
    .filter((v) => /^\d+\./.test(v))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(
      root,
      version,
      'Camoufox.app/Contents/MacOS/camoufox',
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Why a candidate was rejected. Kept so the report can name a cause, not just "no". */
const REJECT = {
  MISSING: 'does-not-exist',
  NOT_EXECUTABLE: 'exists-but-not-executable',
  NOT_LAUNCHABLE: 'exists-and-executable-but-did-not-run',
};

function listVersionsIn(root) {
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root)
      .filter((v) => /^\d+\./.test(v))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Every layout we know how to produce, newest version first within each.
 *
 * `browsers/official/<version>/Camoufox.app/...` is NOT camoufox-js's layout —
 * it is produced by some other installer on developer machines. It is kept
 * because it is what actually works on this repo's author's machine, and
 * dropping it would break every local run to fix CI.
 */
export function camoufoxBinaryCandidates() {
  const out = [];
  const push = (p, source) => {
    if (p && !out.some((c) => c.path === p)) out.push({ path: p, source });
  };

  // 1. Explicit escape hatch. Highest precedence, and the documented manual fix.
  push(process.env.CAMOUFOX_BIN, 'env:CAMOUFOX_BIN');
  push(process.env.CAMOUFOX_EXECUTABLE, 'env:CAMOUFOX_EXECUTABLE');

  // 2. camoufox-js's own install root. Flat, no browsers/official segment.
  //    CAMOUFOX_INSTALL_DIR is honoured first because that is the documented
  //    override (camoufox-js pkgman.js:44 reads it too).
  const jsRoots = [
    process.env.CAMOUFOX_INSTALL_DIR,
    path.join(os.homedir(), 'Library/Caches/camoufox'),
    path.join(os.homedir(), '.cache/camoufox'),
  ].filter(Boolean);

  // ALL known launcher names, not just this platform's.
  //
  // 5 Oct 2026 — I first wrote this as a `process.platform` switch. That was
  // correct on real Linux CI but made the resolver untestable off-platform: on a
  // macOS box pointed at a simulated Linux cache it looked only for
  // `Camoufox.app`, reported "not-fetched", and I could not tell whether the
  // fix worked or the simulation was merely wrong. A resolver whose correctness
  // cannot be exercised is a resolver that cannot be trusted.
  //
  // Probing every name is strictly safer here BECAUSE `launches()` below runs
  // `--version` and checks it says "camoufox", so a wrong-platform file at a
  // matching name is rejected rather than accepted. Being maximally permissive in
  // the SEARCH and strict in the VERIFY is the division of labour; being strict
  // in the search only means "absent" and "somewhere else" look identical.
  const platformLaunchers = [
    'Camoufox.app/Contents/MacOS/camoufox', // macOS
    'camoufox-bin',                          // Linux
    'camoufox.exe',                          // Windows
  ];

  for (const root of jsRoots) {
    for (const rel of platformLaunchers) {
      push(path.join(root, rel), `camoufox-js-layout:${root}`);
    }
    // versioned subdirs, newest first
    for (const version of listVersionsIn(root)) {
      for (const rel of platformLaunchers) {
        push(path.join(root, version, rel), `camoufox-js-versioned:${root}/${version}`);
      }
    }
  }

  // 3. The layout this repo's own tests were written against.
  for (const root of CACHE_ROOTS) {
    for (const version of listVersionsIn(root)) {
      push(
        path.join(root, version, 'Camoufox.app/Contents/MacOS/camoufox'),
        `browsers-official:${root}/${version}`,
      );
    }
  }

  return out;
}

/**
 * Does this path actually RUN? `existsSync` is necessary but not sufficient:
 * it says nothing about the executable bit or the architecture, and the repo's
 * own postinstall.js checks X_OK for exactly this reason. A `--version` probe is
 * the only check that cannot be fooled by a file that merely exists.
 *
 * 5 Oct 2026 — the `--version` probe is itself sensitive to HOW the path is
 * spelled. Measured on beta.31:
 *
 *   real binary                      -> status 0, "Camoufox Camoufox 152.0.4-beta.31"
 *   symlinked .app PARENT DIRECTORY  -> status 0, same output. Fine.
 *   symlinked FILE                   -> status 255, "Couldn't load XPCOM." FALSE.
 *
 * Firefox locates its profile/libraries relative to the real executable, so a
 * bare symlink to the binary loses that context and `--version` dies. So a
 * symlinked binary is not "present but unusable" in any meaningful sense -- it is
 * a perfectly good browser behind a path that cannot probe it. Reporting mode
 * 'unusable' there would hard-fail a developer whose cache is symlinked, which is
 * a false failure on a working setup.
 *
 * So: resolve symlinks, and hand back the REAL path. Note what was measured
 * here, because the first version of this comment guessed and was wrong -- I
 * wrote that the launcher "may follow a symlink correctly for a full launch".
 * Measured on beta.31:
 *
 *   real binary          --version status 0    firefox.launch() OK
 *   symlinked .app DIR   --version status 0    firefox.launch() OK
 *   symlinked FILE       --version status 255  firefox.launch() FAILS
 *
 * A bare symlink to the binary does not work for a real launch either, so
 * resolving is not just about making the probe pass -- returning the symlink
 * would hand Playwright a path that dies at launch() time, in CI, with an opaque
 * "Failed to launch the browser process". Returning the REAL path is the only
 * correct answer.
 */
function launches(bin) {
  const probe = (p) => {
    try {
      const r = spawnSync(p, ['--version'], { timeout: 20000, encoding: 'utf8' });
      return r.status === 0 && /camoufox/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    } catch {
      return false;
    }
  };
  if (probe(bin)) return true;
  try {
    const real = fs.realpathSync(bin);
    if (real !== bin) return probe(real);
  } catch {
    /* dangling or unreadable link: nothing better to try */
  }
  return false;
}

/**
 * Resolve the real engine, or explain precisely why not.
 *
 * Returns `{ bin, mode, reason, report }` where mode is one of:
 *   'ok'          — a candidate launched
 *   'not-fetched' — nothing was found anywhere; a legitimate skip (mode i)
 *   'unusable'    — something was found but would not run; NOT a skip (mode ii)
 *   'unknown-layout' — a browser exists at a path we do not recognise, or we
 *                      found files we could not classify (mode iii). Loud
 *                      everywhere, because nobody asked for absence.
 *
 * `report` lists every candidate and why it was rejected, so the failure message
 * can name the layouts that were probed. That alone would have surfaced the
 * Linux layout bug in seconds.
 */
export function resolveCamoufox({ verify = true } = {}) {
  const candidates = camoufoxBinaryCandidates();
  const report = [];

  if (!candidates.length) {
    return {
      bin: null,
      mode: 'not-fetched',
      reason: 'no Camoufox binary found in any known layout',
      report: ['(no candidate paths could even be constructed)'],
    };
  }

  let sawSomething = false;
  for (const { path: p, source } of candidates) {
    if (!fs.existsSync(p)) {
      report.push(`${p}  [${source}]  ${REJECT.MISSING}`);
      continue;
    }
    sawSomething = true;

    // `fs.accessSync` THROWS on failure and returns `undefined` on success.
    // It is not a boolean predicate. So `!fs.accessSync(p, X_OK)` is true on
    // SUCCESS (because !undefined === true) and false on failure — i.e. exactly
    // inverted, which rejected every genuinely runnable binary as
    // "exists-but-not-executable" and then reported mode 'unusable'.
    //
    // Caught by running the resolver against the real binary and getting mode
    // 'unusable' for a binary that demonstrably runs (`--version` -> exit 0).
    // The tell was that beta.30 AND beta.31 were rejected identically: real
    // files do not fail an executability check that reliably.
    //
    // Same shape of error as the handoff's own approvePending() dead helper —
    // an API whose contract was assumed rather than read.
    let executable = true;
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch {
      executable = false;
    }
    if (!executable) {
      report.push(`${p}  [${source}]  ${REJECT.NOT_EXECUTABLE}`);
      continue;
    }
    if (verify && !launches(p)) {
      report.push(`${p}  [${source}]  ${REJECT.NOT_LAUNCHABLE}`);
      continue;
    }
    // Return the RESOLVED path. Measured on beta.31: a bare symlink to the binary
    // fails `firefox.launch()` outright, not just the `--version` probe, so
    // returning the symlink would hand Playwright a dead path and blow up later
    // with an opaque "Failed to launch the browser process". A symlinked parent
    // .app directory resolves to the real thing and works fine.
    let resolved = p;
    try {
      resolved = fs.realpathSync(p);
    } catch {
      /* not a link, or unreadable -- the path itself is the best we have */
    }
    if (resolved !== p) {
      report.push(`${p}  [${source}]  resolved-symlink -> ${resolved}`);
    }
    return { bin: resolved, mode: 'ok', reason: `resolved from ${source}`, report };
  }

  // Something exists at a path we recognise but it would not run -> never a skip.
  if (sawSomething) {
    return {
      bin: null,
      mode: 'unusable',
      reason: 'a Camoufox binary exists but did not launch',
      report,
    };
  }

  // MODE (iii) — made REAL, 5 Oct 2026. Previously this was documented in three
  // comments and never returned, so it was dead code: a browser at a path none of
  // our candidate list covers fell straight through to 'not-fetched' and got a
  // SILENT SKIP. An auditor demonstrated exactly that — a working binary at
  // $HOME/opt/camoufox/firefox/camoufox-bin, `1 skipped`, exit 0. That is the
  // ORIGINAL bug reproducing through the fix meant to close it, because
  // `sawSomething` only tracks paths we already knew to look at.
  //
  // So "exists where we do not look" has to be detected by LOOKING, not by
  // guessing. sweepForUnknownCamoufox() searches a bounded set of plausible roots
  // for files whose name identifies them as Camoufox, and only claims
  // 'unknown-layout' when it can point at one by path.
  //
  // The bar is deliberately high: a false 'unknown-layout' hard-fails a developer
  // who simply has not fetched the browser, which is the opposite error. It only
  // fires on a name that is unmistakably a camoufox launcher, in a directory that
  // plainly exists, and the report names the exact file so the remedy is obvious.
  const found = sweepForUnknownCamoufox();
  if (found.length) {
    return {
      bin: null,
      mode: 'unknown-layout',
      reason:
        'a Camoufox launcher exists at a path this resolver does not recognise. ' +
        'It is installed and runnable, so skipping here would silently drop ' +
        'real-engine coverage. Point CAMOUFOX_BIN at it, or fix the layout list.',
      report: [
        ...report,
        'UNRECOGNISED CANDIDATES FOUND BY SWEEP:',
        ...found.map((f) => `  ${f}  [sweep:looks-like-camoufox]`),
      ],
    };
  }

  return {
    bin: null,
    mode: 'not-fetched',
    reason: 'no Camoufox binary present in any known layout',
    report,
  };
}

/**
 * Look for a Camoufox launcher in places our candidate list does not cover.
 *
 * This exists solely to make mode 'unknown-layout' reachable, which is the
 * difference between "installed but invisible" and "not fetched" — the exact
 * distinction the original Linux-CI bug turned on.
 *
 * Conservative by design, because the failure modes are asymmetric:
 *   - false NEGATIVE: we report 'not-fetched' and a developer with an exotic
 *     install gets the old silent skip. Bad, but no worse than today.
 *   - false POSITIVE: we hard-fail a developer who has never fetched the browser.
 *     Actively hostile, and would get this gate deleted.
 * So it only matches names that cannot plausibly be anything else, and it echoes
 * the paths it found so a human can judge.
 *
 * Depth and breadth are bounded: this runs during test collection on every
 * `npm test`, so a naive recursive walk of $HOME would be unacceptable.
 */
function sweepForUnknownCamoufox() {
  const hits = [];
  const seenDirs = new Set();

  // Roots where an install could plausibly live that we do not already scan.
  const roots = [
    path.join(os.homedir(), 'opt'),
    path.join(os.homedir(), '.local'),
    path.join(os.homedir(), '.local/share'),
    path.join(os.homedir(), 'Downloads'),
    '/usr/local',
    '/opt',
  ];

  // Unmistakable launcher names, matched case-insensitively as an EXACT basename.
  const NAMES = new Set(['camoufox', 'camoufox-bin', 'camoufox.exe', 'camoufox-bin.original']);

  const MAX_DEPTH = 4;
  const MAX_HITS = 5;

  const walk = (dir, depth) => {
    if (hits.length >= MAX_HITS || depth > MAX_DEPTH || seenDirs.has(dir)) return;
    seenDirs.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or not a directory: normal, keep going
    }
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip trees that cannot contain a browser and are enormous.
        if (['node_modules', '.git', 'Library', 'Trash', '.Trash'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (NAMES.has(e.name.toLowerCase())) {
        hits.push(full);
      }
    }
  };

  for (const root of roots) {
    if (hits.length >= MAX_HITS) break;
    try {
      if (fs.statSync(root).isDirectory()) walk(root, 0);
    } catch {
      /* absent root is the normal case */
    }
  }
  return hits;
}

/**
 * The real engine, or null. Never a fake -- callers must skip explicitly.
 *
 * KEPT for compatibility with existing callers. Prefer `resolveCamoufox()`,
 * which also tells you WHY, because a bare null is what let three distinct
 * failures hide behind one skip.
 */
export function findCamoufoxBinary() {
  return resolveCamoufox().bin;
}

/** One line an operator can act on. Printed on every skip, local or CI. */
export function camoufoxSkipExplanation(resolution) {
  return [
    `Camoufox real-engine tests ${resolution.mode === 'ok' ? 'resolved' : 'DID NOT RUN'}: ${resolution.reason}`,
    'Paths probed:',
    ...resolution.report.map((r) => `  - ${r}`),
    resolution.mode === 'not-fetched'
      ? 'Fetch it with: npx camoufox-js fetch   (or set CAMOUFOX_BIN to an existing binary)'
      : 'This is NOT a "developer has not fetched it" case and must not be skipped silently.',
  ].join('\n');
}

/**
 * THE GATE. Replaces `BIN ? describe : describe.skip`.
 *
 * The old form reported "no binary" for three unrelated situations and skipped
 * on all three, which is how the real-engine 307/308 coverage disappeared from
 * CI without a word. The rules here are deliberately asymmetric:
 *
 *   mode 'not-fetched' -> SKIP, and say so loudly on every machine. A developer
 *                         who has not fetched a 400MB browser is in an expected
 *                         state, and failing their `npm test` would be hostile
 *                         and would get this deleted.
 *   mode 'unusable'    -> FAIL. The browser is there and we are claiming coverage
 *                         we are not delivering.
 *   mode 'unknown-layout' -> FAIL everywhere, CI or not. The browser EXISTS at a
 *                         path we do not recognise. Nobody asked for its absence,
 *                         so silently skipping is a lie about coverage.
 *   CI set + not 'ok'  -> FAIL. In CI nobody is "a developer who hasn't fetched
 *                         it" — the workflow is supposed to install it, so a
 *                         miss there is a broken workflow, not a local choice.
 *
 * The local warning is NOT optional and NOT loud-only-in-CI. The skip is
 * invisible everywhere today — no failure, no exit-code change — so a developer
 * can carry a dead resolver for months with green tests locally and never learn
 * that CI's gate never sees their local breakage. A warning can be ignored; a
 * local FAILURE can be muted by habit (`--ci=false`, or just not running the
 * suite), which is why this warns locally and reserves failure for CI plus the
 * two genuinely-broken modes.
 */
export function describeCamoufoxEngine(name, fn) {
  const resolution = resolveCamoufox();
  const bin = resolution.bin;

  // ALWAYS print. A silent skip is the whole bug.
  console.warn(`\n[camoufox] ${name}: ${resolution.reason}`);

  // `CI` must be tested for PRESENCE, not truthiness. An auditor found that
  // `CI=''` (set but empty — which some CI systems export) is falsy, so
  // `!process.env.CI` was true and the suite SILENTLY SKIPPED on CI. Verified:
  // exit 0 with CI='', exit 1 with CI=true. The distinction that matters is
  // "did the environment say this is CI", not "is the value true".
  const inCI = process.env.CI !== undefined;
  const skipIsLegitimate = resolution.mode === 'not-fetched' && !inCI;

  if (bin) {
    describe(name, () => {
      beforeAll(() => {
        process.env.CAMOUFOX_BIN = bin;
      });
      fn(bin);
    });
    return;
  }

  if (skipIsLegitimate) {
    console.warn(camoufoxSkipExplanation(resolution));
    describe.skip(name, fn);
    return;
  }

  // Everything else FAILS, loudly, with the probed-layout report attached.
  const why =
    resolution.mode === 'not-fetched'
      ? 'CI is set and the Camoufox binary is absent. The workflow is supposed to install it.'
      : resolution.mode === 'unusable'
        ? 'A Camoufox binary exists but did not launch. Skipping here would claim coverage that is not running.'
        : 'Camoufox exists in a layout this resolver does not recognise.';

  describe(name, () => {
    test('the real engine must actually run for these tests to mean anything', () => {
      // THROW, do not `expect.fail(...)`.
      //
      // 5 Oct 2026 — this was `expect.fail(msg)` and it threw
      //   TypeError: expect.fail is not a function
      // discarding the entire diagnostic. My first fix was to add the missing
      // `import { expect } from '@jest/globals'`, which was WRONG: the import was
      // never the problem. Measured on jest 30.4.2,
      //   typeof expect      -> 'function'
      //   typeof expect.fail -> 'undefined'   (and 'fail' in expect === false)
      // so `@jest/globals` does not expose `fail` in this version at all. The
      // import I added was cargo-culted from a version where it exists.
      //
      // A thrown Error is version-independent and puts the message in the failure
      // output verbatim, which is the entire point — the probed-layout report has
      // to reach the operator.
      throw new Error(
        [
          `Camoufox real-engine coverage CANNOT BE SKIPPED HERE.\n\n${why}\n\n`,
          camoufoxSkipExplanation(resolution),
          '\n\nFix the resolver, or set CAMOUFOX_BIN to a working binary.',
          'A skip here reports GREEN while executing none of the real-engine',
          'coverage of the 307/308 redirect finding -- the exact failure this gate exists to prevent.',
        ].join('\n'),
      );
    });
  });
}

/**
 * A route double that records how it was resolved. Used to prove the invariant
 * that matters most: every request ends in exactly one continue() or abort().
 */
export function fakeRoute() {
  const resolutions = [];
  return {
    resolutions,
    continue: async () => {
      resolutions.push('continue');
    },
    abort: async () => {
      resolutions.push('abort');
    },
  };
}

/** A Playwright Request double. Mirrors the four accessors policy.js calls. */
export function fakeRequest({
  method = 'GET',
  url = 'http://example.test/',
  postData = null,
  resourceType = null,
  isNavigation = false,
  page = null,
} = {}) {
  return {
    method: () => method,
    url: () => url,
    postData: () => postData,
    resourceType: () => resourceType,
    isNavigationRequest: () => isNavigation,
    frame: () => ({ page: () => page }),
  };
}

export const MOCK_PAGE_HTML = `<!doctype html><meta charset=utf-8><title>gate test</title>
<a id="getlink" href="/ping?id=1">Continue</a>
<form method="post" action="/charge">
  <input name="amount" value="500">
  <button id="postform" type="submit">Pay now</button>
</form>
<button id="jsfetch" onclick="fetch('/charge',{method:'POST',body:'amount=500'})">Cancel subscription</button>
<button id="hushlabel" onclick="fetch('/charge',{method:'POST',body:'amount=1'})">Continue</button>
<button id="jsput" onclick="fetch('/charge',{method:'PUT',body:'amount=1'})">Refresh</button>
<button id="jsdelete" onclick="fetch('/charge',{method:'DELETE'})">Archive</button>
<button id="jsunknown" onclick="fetch('/charge',{method:'FROBNICATE'})">Sync</button>
<button id="openpop" onclick="window.open('/popup','_blank')">open popup</button>
<img id="theimg" src="/pixel.gif" width="1" height="1">
`;

export const MOCK_POPUP_HTML = `<!doctype html><meta charset=utf-8><title>popup</title>
<button id="popupcharge" onclick="fetch('/charge',{method:'POST',body:'from=popup'})">Confirm</button>
`;

/**
 * A server that records every request that actually arrived, which is the only
 * honest way to assert "the effect did not land". Asserting on what the gate
 * decided instead of what landed is how you write a test that passes because
 * the thing under test is a mock.
 */
export function startRecordingServer() {
  const arrived = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        arrived.push({ method: req.method, path: req.url, body });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(MOCK_PAGE_HTML);
        } else if (req.url === '/popup') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(MOCK_POPUP_HTML);
        } else if (req.url === '/pixel.gif') {
          res.writeHead(200, { 'Content-Type': 'image/gif' });
          res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        arrived,
        port,
        url: `http://127.0.0.1:${port}/`,
        mutatingArrivals: () => arrived.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'),
        close: () => new Promise((done) => srv.close(done)),
      });
    });
  });
}

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Poll a predicate until it holds or the budget runs out. */
export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}
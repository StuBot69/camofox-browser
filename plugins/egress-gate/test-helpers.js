/**
 * Test helpers for the egress gate.
 *
 * The real-engine tests need a Camoufox binary. Resolving it is done here, once,
 * rather than by assuming an env var: the repo's own camoufox-js resolution path
 * throws on this machine (no version.json at the cache root), and a test that
 * silently degrades to fakes is exactly the kind of test that proves nothing.
 * So find the binary or say clearly that the real-engine tests were skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

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

/** The real engine, or null. Never a fake -- callers must skip explicitly. */
export function findCamoufoxBinary() {
  const fromEnv = process.env.CAMOUFOX_BIN || process.env.CAMOUFOX_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const root of CACHE_ROOTS) {
    const found = camoufoxBinaryIn(root);
    if (found) return found;
  }
  return null;
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
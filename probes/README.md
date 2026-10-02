# probes/

Measurement scripts. **Evidence, not tests.** Each one launches a real Camoufox
instance and asserts against a real HTTP server, which is the layer
`armed.test.js` cannot reach — those tests drive a mock context and can prove a
function was *called*, never that the server actually *behaved*.

The distinction matters because of how this gate got its two real findings: both
were invisible to the unit suite, and one of them was found only after a false
green told us there was nothing there.

## Running them

All of them need the browser binary:

    export CAMOUFOX_BIN=~/Library/Caches/camoufox/browsers/official/*/Camoufox.app/Contents/MacOS/camoufox
    node probes/measure_redirect_handler.mjs

Each script states its own invocation in a header comment. They are standalone
`node` scripts with no test runner, and they exit non-zero if their claim is
falsified. They are not wired into `jest`, deliberately: they take ~10-30s each
and they need a live browser, so they are for when a claim is in question, not on
every commit.

## What each one measures

### `measure_redirect_handler.mjs` — the 307/308 bypass

**The most important file here.** This is the probe that found the hole the whole
design is shaped around.

Claim under test: a 307/308 redirect's second POST leaves the machine with **no
`context.route()` handler invocation at all**, so `grantCovers()` is never
consulted for the hop that actually carries the body and the cookie.

Latest run (Camoufox 152.0.4-beta.31):

    B  navigating <form method=post>, 307 -> /hop2
      server received   : POST /r307, POST /hop2
      handler invoked   : POST /r307
      >> BODY LANDED WITHOUT A HANDLER INVOCATION: POST /hop2 body="card=4111111111111111"
      VERDICT           : BYPASS x1

Both a `fetch` and a navigating `<form>` are covered, because they take different
code paths through the engine and both escape.

**There is no in-plugin fix.** The follow-up hop is issued *below* the
interception layer. `grantCovers()` in `policy.js:176` would correctly refuse it —
it is simply never reached. Playwright's route API does not promise redirect
coverage. Prevention requires a proxy-level control or a browser/CDP change.

This is why the gate **detects and reports** rather than pretending to prevent.

### `measure_redirect_gate.mjs` — the same finding, first pass

The wider first measurement of the redirect behaviour, against the real plugin.
Superseded by `measure_redirect_handler.mjs`, which is narrower and binary: the
first pass conflated `gate.stats.allowed + refused` with handler invocations, and
`allowedSilent` counts GETs, so its number could not answer the question that
mattered. Kept because it measures a wider surface.

### `measure_websocket_gate.mjs` — WebSocket interception

Claim under test: WebSocket handshakes are invisible to `context.route()`.

Latest run:

    context.routeWebSocket exists  : true
    registration succeeded         : true
    ws handler invoked             : 1
    server saw /ws                 : 0

`routeWebSocket()` **does** intercept on this engine, so it is wireable. But the
server never saw `/ws` and the browser state was `timeout` — meaning
`connectToServer()` does not complete, so there is no pass-through path to approve
into. That is a **narrower and more awkward** result than "wire it and it works",
and it is why WebSocket support is documented as not shipped rather than
half-shipped.

### `measure_firefox_gate.mjs` — page.route() on Firefox

Claim under test: `page.route()` actually intercepts in playwright-core's
**Firefox**. The original proof used Chromium via the Python API; the engine that
really runs here is Camoufox, and route interception has historically been the
weak spot there. A Chromium result does not transfer.

### `measure_context_gate.mjs` — the three unproven assumptions

The gate installs on the `BrowserContext` rather than each page, so its coverage
claim rested on three assumptions nobody should take on trust:

- **A.** `context.route()` intercepts at all on this engine
- **B.** it covers pages created *after* the route is installed
- **C.** it covers popups, which never pass through `newPage()`

Also measures **per-click latency with the gate on and off**, rather than
asserting it, and re-checks the static-asset assumption that a `<script>` or
`<img>` load is a GET and therefore passes.

## When to reach for these

Reach for them when a claim about coverage is in question — a new engine version,
a refactor of the route install path, or anyone proposing that the gate "now"
covers something it did not cover before. Each probe states the claim it tests in
its own header, so read the header before trusting the output.

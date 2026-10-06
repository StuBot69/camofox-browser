# probes/

Measurement scripts. **Evidence, not tests.** Each one launches a real Camoufox
instance and asserts against a real HTTP server, which is the layer
`armed.test.js` cannot reach — those tests drive a mock context and can prove a
function was *called*, never that the server actually *behaved*.

The distinction matters because of how this gate got its two real findings: both
were invisible to the unit suite, and one of them was found only after a false
green told us there was nothing there.

## Running them

All of them need the browser binary.

**Resolve it with `ls`, not a glob in an assignment.** Bash expands `~` in an
assignment but does NOT do pathname expansion there, so
`export CAMOUFOX_BIN=~/.../*/camoufox` silently assigns the literal, unexpanded
pattern and every run fails with "executable doesn't exist" — which reads like a
missing browser. Use command substitution:

    CAMOUFOX_BIN="$(ls -d ~/Library/Caches/camofox/browsers/official/*/Camoufox.app/Contents/MacOS/camoufox 2>/dev/null | head -1)"
    [ -x "$CAMOUFOX_BIN" ] && echo "BIN OK: $CAMOUFOX_BIN" || echo "BIN NOT RESOLVED"
    export CAMOUFOX_BIN
    node probes/measure_redirect_handler.mjs

If `[ -x ]` fails, the path may still be fine: on this machine the binary's
visibility through `~/Library` is **intermittently denied by macOS sandboxing,
surfacing as `No such file or directory` rather than a permissions error**, while
the file is installed and launches fine minutes later. Retry the whole run
rather than concluding the browser is gone. See `measure_redirect_gate.mjs`
for the same hazard handled in code.

Each script states its own invocation in a header comment. They are standalone
`node` scripts with no test runner. They are not wired into `jest`, deliberately:
they take ~10-30s each and they need a live browser, so they are for when a claim
is in question, not on every commit.

### Which of them can actually fail — read this before trusting a green

**A probe that only prints its verdict cannot fail a build, and its green means
nothing.** Corrected 5 Oct 2026: this file previously claimed *all* the probes
"exit non-zero if their claim is falsified". That was false. As of now:

| Probe | Exits non-zero on a falsified claim? |
|---|---|
| `check_demo_pay_path.mjs` | **yes** — failures collected via `say()`, gates `process.exit(1)` |
| `render_check.mjs` | **yes** — same pattern |
| `measure_redirect_gate.mjs` | **yes** — per-case `expect`, `problems[]`, non-zero exit |
| `measure_firefox_gate.mjs` | **yes** — `say()` recorder, non-zero exit |
| `measure_redirect_handler.mjs` | no — prints `VERDICT: BYPASS xN`, always exits 0 |
| `measure_websocket_gate.mjs` | no — prints, always exits 0 |
| `measure_context_gate.mjs` | no — prints, always exits 0 |

For the three that only print, **read the output; do not rely on the exit code.**
Treat that as outstanding work, not as a settled property of those files.

Every probe must also be able to distinguish "the gate did the right thing" from
"the scenario never ran". A control case that registers a grant for one URL while
the page requests another scores identically to a perfect gate — see
`measure_redirect_gate.mjs` cases C and D, which were vacuous until 5 Oct 2026.

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

`routeWebSocket()` **does** intercept on this engine, so refusal works and is
wired into arming: every handshake goes through the policy and the approval
queue, and unapproved ones are closed. But the server never saw `/ws` and the
browser state was `timeout` — meaning `connectToServer()` does not complete, so
there is no pass-through path to approve into. An approved socket is therefore
refused too, loudly and with its own reason
(`egress_gate_websocket_passthrough_unsupported`), because a refused socket is
diagnosable and a phantom connected one is not. If this probe ever shows the
server receiving the upgrade, the gate should be changed to allow — that would
be the engine gaining a capability, not the test going stale.

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

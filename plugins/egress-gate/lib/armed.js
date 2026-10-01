/**
 * THE ARMED-STATE ASSERTION -- the thing that does not exist yet in this gate.
 *
 * WHY THIS FILE IS THE DELIVERABLE AND THE POLICY IS NOT.
 *
 * The policy (./policy.js) decides whether a request is safe. It is 72 tests of
 * trusted logic and it is correct. But a correct policy behind a route that was
 * never installed is not a gate, it is a very well-tested no-op, and the only
 * symptom is that the user believes they are protected.
 *
 * That is not hypothetical. It is exactly what happened to the MV3 extension
 * this gate was measured against: a bad rule ID threw inside
 * declarativeNetRequest.updateSessionRules(), zero rules were installed, the
 * badge said nothing, and the probe reported PASS on a browser with nothing
 * loaded. A silently disarmed gate is WORSE than no gate, because no gate is a
 * choice the user can see.
 *
 * So the question this file answers is not "should this POST be allowed" but
 * "is the thing that answers that question actually running, and can I prove it
 * from outside this process without reading prose".
 *
 * THE THREE THINGS THAT MATTER, IN ORDER OF HOW EASILY THEY ARE FALSIFIED:
 *
 *   1. "route() returned" is NOT proof. It is the same instrument that lied
 *      last time. updateSessionRules() resolving told the extension nothing, and
 *      context.route() resolving tells us nothing either -- the call returning
 *      says the API accepted a pattern, not that a single byte of traffic will
 *      ever reach the handler. So install is recorded, but it is not credited.
 *
 *   2. "the handler has been observed running" IS proof. The only assertion
 *      that cannot lie is a real request, issued through the real context,
 *      that the real handler reports seeing. That is canary(), below. It costs
 *      one page and one unroutable URL per session context, and it is the whole
 *      reason the gate can be believed. If canary() does not see its own token,
 *      the route is not intercepting and the gate says so.
 *
 *   3. "it was armed once" is not enough either. Routes can be unrouted, the
 *      context can die, the handler can throw into Playwright's dispatcher, and
 *      the watchdog itself can stop ticking. A gate whose watchdog stops
 *      watching is not a gate, so watchdog staleness is itself a disarmed state
 *      rather than an absence of one.
 *
 * FAIL CLOSED, which here means two different things and both are real:
 *   - per session: an unarmed context is DESTROYED, not merely flagged. There
 *     is no state in which a user browses through a context the gate cannot
 *     account for.
 *   - at startup: if arming throws, register() rethrows, so the server does not
 *     come up claiming protection it does not have. There is no "start anyway,
 *     warn in the log" path.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. routePresence() below reads a Playwright
 * private field (_routes). That is load-bearing enough to notice a route that
 * vanished, and deliberately NOT load-bearing enough to declare a gate
 * disarmed: if playwright-core renames it, the honest answer is
 * checks.route === 'unavailable', not 'disarmed'. Failing everyone closed
 * because a dependency renamed an underscore field is not fail-closed, it is
 * just broken. The behavioural canary is what decides, and the structural read
 * is corroboration.
 *
 * THE AMENDMENT, RESOLVED AS A MEASURED LIMITATION RATHER THAN A FIX.
 *
 * approval.js grants on method+url, and policy.grantCovers() (policy.js:176)
 * would correctly refuse a second hop against a grant for the first. That is not
 * the problem. The problem is that grantCovers() is never reached: a 307/308's
 * second POST is issued BELOW context.route(), so it does not become a request
 * inside the interception layer at all.
 *
 * Measured in this repo against real Camoufox, measure_redirect_handler.mjs:
 *
 *   server received   : POST /r307, POST /hop2
 *   handler invoked   : POST /r307
 *   playwright event  : POST /r307, POST /hop2
 *   audit rows        : POST /r307=allowed
 *   >> BODY LANDED WITHOUT A HANDLER INVOCATION: POST /hop2 body="card=4111..."
 *
 * Reproduced for fetch and for a navigating <form method=post>. 301/302 are not
 * affected: they downgrade POST to GET and the body does not follow.
 *
 * NO IN-PLUGIN FIX EXISTS. Playwright's route API does not promise redirect
 * coverage, and its maintainer calls the current behaviour working as designed.
 * Prevention at this layer would mean a proxy-level control or a browser/CDP
 * change, neither of which is this deliverable.
 *
 * SO WHAT THIS FILE DOES ABOUT IT: detects it, loudly, and refuses to describe
 * itself as covering it. A hop is visible on page.on('request') and
 * context.on('request') -- both see /hop2 -- so watchRedirects() below watches
 * for a mutating request that the gate never recorded deciding, and screams.
 * Detection is not prevention, and the snapshot says "detected", never
 * "prevented". SCOPE below is the string an operator reads.
 */

import { randomUUID } from 'node:crypto';
import { isIrreversibleMethod, isNetworkUrl } from './policy.js';

/**
 * WHAT THE GATE COVERS, AS DATA.
 *
 * This is the honest alternative to a reassuring green. It is published in the
 * snapshot and served by /egress-gate/armed so that the word "armed" arrives
 * with its limits attached, instead of a caller having to remember this file.
 * `covers` and `excludes` are claims, so they are string arrays rather than
 * booleans -- a boolean cannot be wrong in a visible way.
 */
export const SCOPE = Object.freeze({
  covers: Object.freeze([
    'every context the server creates for egress-gate users',
    'every request initiated in those contexts, including pages and popups created later',
    'the first navigation of every such page',
    'WebSocket handshakes via context.routeWebSocket(), decided through the same policy and approval queue',
  ]),
  excludes: Object.freeze([
    'the follow-up hop of a 307/308 redirect chain: issued below context.route(), never reaches the handler, DETECTED but NOT prevented',
    'requests issued by browser-internal processes outside the context, e.g. some prefetch and service-worker-originated fetches not attributed to a page',
  ]),
  /**
   * Not a coverage gap, but a limitation an operator must know about before
   * concluding the gate "blocks sockets". It blocks them ALL, including approved
   * ones: on Camoufox/Firefox with playwright-core 1.59.1, routeWebSocket()
   * intercepts (so refusal works) but connectToServer() resolves without the
   * server ever seeing the handshake, so there is no pass-through to approve
   * into. Measured, not read off a doc: the error is swallowed by playwright's
   * client, which is why this needed a live server to establish.
   */
  websocketPassThrough: 'unsupported-on-this-engine',
  enforcedAt: Object.freeze(['context.route', 'context.routeWebSocket']),
  preventionOfRedirectChains: 'unavailable-in-plugin',
  // context.on, not page.on, deliberately: a context listener also sees requests
  // from pages this plugin never registered, which is exactly the population the
  // exclusion above is about. Measured with both; context.on is a superset.
  detectionOfRedirectChains: 'context.on(request)',
});

/**
 * The three states. Deliberately a closed set of three so the snapshot is
 * assertable from outside without interpreting anything.
 */
export const STATES = Object.freeze({
  /** No arming attempt has been recorded yet. Not armed, and not yet a failure. */
  PENDING: 'pending',
  /** Installed, and canary() has seen the handler run. */
  ARMED: 'armed',
  /** Install failed, canary failed, a tracked context was lost, or the watchdog stalled. */
  DISARMED: 'disarmed',
});

/**
 * Result vocabulary for the individual checks. Published in the snapshot so a
 * consumer can tell "this passed" from "this never ran" -- the distinction the
 * extension probe could not make.
 */
export const CHECKS = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNAVAILABLE: 'unavailable',
  PRESENT: 'present',
  ABSENT: 'absent',
  ALIVE: 'alive',
  DEAD: 'dead',
  STALE: 'stale',
  FRESH: 'fresh',
  NONE: 'none',
});

/**
 * Reasons a gate is disarmed. These are the values an operator greps for and
 * the values a machine branches on; the human-readable phrasing lives in the
 * log line, never here.
 */
export const DISARM_REASONS = Object.freeze({
  INSTALL_THREW: 'install-threw',
  CANARY_NOT_SEEN: 'canary-not-seen',
  CANARY_TIMED_OUT: 'canary-timed-out',
  CONTEXT_DEAD: 'context-dead',
  ROUTE_VANISHED: 'route-vanished',
  HANDLER_ERRORED: 'handler-errored',
  WATCHDOG_STALLED: 'watchdog-stalled',
});

/**
 * Redirect-chain egress that was seen leaving the machine with no gate decision.
 *
 * This is NOT a disarm reason, and the distinction is the whole point. The route
 * is armed and working; it is simply not the layer a redirected request is
 * issued from. Reporting it as "disarmed" would be a different lie -- it would
 * suggest the gate stopped doing its job, and would bury the one fact an
 * operator needs: this is a hole in coverage that no in-plugin fix closes.
 * So it has its own vocabulary, its own counter, and its own alarm.
 */
export const EGRESS_ALERTS = Object.freeze({
  UNGATED_MUTATING_REQUEST: 'ungated-mutating-request',
});

/**
 * How long after a request event the gate is given to claim it before we call it
 * ungated. The handler runs synchronously in the route dispatcher, so this only
 * has to cover scheduling jitter between the 'request' event and the handler
 * entry; it is a delay, not a window in which an attacker does anything useful.
 */
const DEFAULT_UNGATED_GRACE_MS = 250;

/**
 * Thrown when a gate cannot be armed. Carries a stable code and the failing
 * check so the HTTP layer can answer with something a caller can branch on,
 * rather than a stack trace in a 500 body.
 */
export class GateDisarmedError extends Error {
  constructor(reason, detail = {}) {
    super(`egress gate is not armed: ${reason}`);
    this.name = 'GateDisarmedError';
    this.code = 'egress_gate_disarmed';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The canary URL.
 *
 * `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so
 * the probe request provably reaches no server. That is not a nicety: the
 * probe must not be able to cause egress, and a canary pointed at a real host
 * would be an unguarded request made by the thing meant to be guarding.
 *
 * Routing happens before name resolution, so a request to an unresolvable host
 * still exercises the handler. If the route is NOT installed, the handler never
 * fires and DNS is the only thing that happens -- which is exactly the failure
 * we need to detect, and it fails silently without this token to look for.
 */
const CANARY_HOST = 'egress-gate-canary.invalid';

/** Ticks of the watchdog. Watchdog staleness is judged against this. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15000;

/** How many recent handler sightings to remember. Enough for concurrent canaries. */
const HANDLER_SEEN_LIMIT = 64;

/**
 * How long a handler-first claim survives, relative to the grace window.
 *
 * The claim covers the ordering where the route handler runs BEFORE the browser
 * delivers its 'request' event. A claim that expires too early turns that
 * legitimate race into a false alarm on every gated request; one that expires
 * too late suppresses a real alarm for a repeat URL. Both are bad, so the
 * window is several times the grace period: the alarm is the expensive mistake
 * to make, and a false "a mutation left undecided" is the one that teaches
 * people the detector is noise.
 */
const CLAIM_TTL_MULTIPLIER = 8;
const MIN_CLAIM_TTL_MS = 2000;

/**
 * A watchdog is considered stalled after missing this many intervals. Three
 * rather than one because a single late tick in a busy Node process is not
 * evidence of anything, and a gate that disarms itself on GC pause trains
 * people to ignore it.
 */
const WATCHDOG_STALE_AFTER_TICKS = 3;

/**
 * Wrap the installed handler so an exception escaping it is counted and the
 * request is refused rather than left hanging.
 *
 * gate.handle() is written not to throw (its resolve is idempotent and
 * swallows a page that died mid-decision). This wrapper exists for the day
 * that stops being true: an error thrown here would land inside Playwright's
 * route dispatcher, the request would never be resolved, and the page would
 * hang until the action budget killed the tab. That presents as "camofox is
 * broken", which is the fastest way to get a gate switched off. So: count it,
 * record it, refuse the request, and let the watchdog see the error count.
 */
function guardHandler(handler, { onError }) {
  return async function guardedHandler(route, request) {
    try {
      return await handler(route, request);
    } catch (err) {
      onError(err, request);
      // Fail closed, and never let the refusal itself throw: an unresolved
      // route is the one outcome strictly worse than a refused one.
      try {
        await route.abort();
      } catch {
        /* the page is gone; there is nothing left to unblock */
      }
      return undefined;
    }
  };
}

/**
 * Read the route table out of a Playwright context.
 *
 * This is the corroborating check, never the deciding one. Playwright exposes
 * no public way to ask "is my handler still registered", and
 * BrowserContext._routes is an internal array that has moved between versions.
 * If it cannot be read we say 'unavailable' and let canary() carry the
 * decision. If it can be read and our handler is absent, the route really did
 * go away -- someone called unroute/unrouteAll behind us -- and that IS a
 * disarmed state, because a context whose route was removed intercepts nothing.
 */
function routePresence(context, ourHandler) {
  try {
    const routes = context?._routes;
    if (!Array.isArray(routes)) return CHECKS.UNAVAILABLE;
    const present = routes.some((r) => r?.handler === ourHandler);
    return present ? CHECKS.PRESENT : CHECKS.ABSENT;
  } catch {
    return CHECKS.UNAVAILABLE;
  }
}

export function createArmedState({
  /** The gate. Must expose handle(), installOnContext() and stats. */
  gate,
  log = () => {},
  now = () => Date.now(),
  /** Resolve a userId to its session record, or undefined. */
  lookupSession = () => undefined,
  /** Tear a session down. Used to make fail-closed real rather than advisory. */
  destroySession = async () => false,
  /** Records the gate saw a request. Fed by gate.observe, asserted by canary. */
  canaryTimeoutMs = 5000,
  /**
   * Grace period before an unclaimed mutating request is reported ungated. See
   * DEFAULT_UNGATED_GRACE_MS. Exposed so the test can shrink it and assert the
   * detector fires, rather than sleeping on the production value.
   */
  ungatedGraceMs = DEFAULT_UNGATED_GRACE_MS,
  watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  /**
   * Behavioural re-probe on the watchdog tick. Off by default because it costs
   * a real request per live session per interval, and the structural read plus
   * the handler heartbeat already catch the realistic failures. Turning it on
   * buys defence against a route that was removed by a third party in a way
   * that left the handler object intact -- at a price worth naming.
   */
  deepProbe = false,
  enabled = true,
  audit = gate?.audit,
} = {}) {
  if (!gate) throw new Error('createArmedState requires a gate');

  const sessions = new Map();

  /**
   * Mutating requests seen on page.on('request') that the gate has not claimed,
   * keyed by a synthetic id. A hop2 lands here and stays here, because no
   * handler entry will ever arrive to claim it.
   */
  const pendingUnclaimed = new Map();

  /**
   * Mutating requests the gate has actually decided on, as method+url keys with
   * the timestamp of the decision. Watched by watchRedirects() so that a normal
   * gated POST is never mistaken for a bypass.
   */
  const claimed = new Map();

  const egress = {
    detected: 0,
    suppressed: 0,
    lastAt: null,
    lastAlert: null,
    pending: 0,
  };

  /** Detach handles per user, so session teardown can release the timers. */
  const unwatchers = new Map();

  const handler = {
    invocations: 0,
    errors: 0,
    lastSeenAt: null,
    lastUrl: null,
    lastError: null,
    seenUrls: new Set(),
  };

  const canary = {
    attempts: 0,
    passed: 0,
    failed: 0,
    lastAt: null,
    lastToken: null,
    lastResult: null,
  };

  let state = STATES.PENDING;
  let since = null;
  let reason = null;
  let reasonDetail = null;
  let installFailures = 0;
  let watchdog = null;
  let lastTickAt = null;

  /**
   * Told by the gate about every request it handled, including the ones it
   * allowed silently. This is the observation the canary asserts against: it is
   * fed from the inside of the real handler on the real context, so "the gate
   * saw this" cannot be claimed without the handler having actually run.
   */
  function observe({ method, url }) {
    handler.invocations += 1;
    handler.lastSeenAt = now();
    if (url) handler.lastUrl = url;
    /**
     * Token sightings, kept separately from lastUrl on purpose. lastUrl is a
     * single mutable slot: if the session has traffic of its own while a canary
     * is in flight, lastUrl can be overwritten by an unrelated request between
     * the canary's request and the check below, and the canary would then
     * conclude it was never seen. It would report a failure rather than a false
     * pass, which is the safe direction -- but it disarms a working gate, and a
     * gate that disarms under load is a gate operators learn to ignore.
     */
    if (url) {
      handler.seenUrls.add(url);
      // Bounded: these exist to answer "did the canary's request arrive?", not
      // to keep a request log.
      while (handler.seenUrls.size > HANDLER_SEEN_LIMIT) {
        const oldest = handler.seenUrls.values().next().value;
        handler.seenUrls.delete(oldest);
      }
    }
    // The gate has now seen this exact method+url, so the redirect watcher must
    // not later call it an ungated egress. Keyed and timestamped, and pruned
    // below: see the note in watchRedirects about why these must not persist.
    if (method && url) {
      const key = decisionKey(method, url);
      claimed.set(key, now());
      // Drop the matching pending entry so the grace timer does not fire.
      for (const [id, entry] of pendingUnclaimed) {
        if (entry.key === key) {
          clearTimeout(entry.timer);
          pendingUnclaimed.delete(id);
          egress.suppressed += 1;
        }
      }
    }
  }

  gate.setObserver?.(observe);

  /**
   * method+url, the same identity grantCovers() compares on. Reusing the shape
   * the policy uses is deliberate: if the key here and the key there ever
   * diverged, the watcher would report bypasses for requests the policy did
   * consider, which is the kind of noise that gets an alarm switched off.
   */
  function decisionKey(method, url) {
    return `${String(method ?? '').toUpperCase()} ${String(url ?? '')}`;
  }

  /**
   * DETECTION for the redirect chain. Not prevention, and named as such.
   *
   * The mechanic: every mutating request the browser reports is parked with a
   * short deadline. The route handler claims the ones it gates by calling
   * observe(). Whatever is still unclaimed when its deadline passes left the
   * machine with a body and no gate decision -- which, for a context where the
   * route is armed, is the 307/308 second hop and essentially nothing else.
   *
   * What this costs and what it does NOT buy, stated plainly:
   *   - It fires AFTER the request is on the wire. The payload has left. There
   *     is no route.abort() available for a request that never became a route.
   *   - It reports the hop2 URL, which is the useful new fact: a human approved
   *     /r307 and something went to /elsewhere with their cookie.
   *   - It deliberately does not kill the session. A blocked mutation is a
   *     policy outcome; an undetectable-at-egress hole is a product limitation,
   *     and pretending the second is the first would train people to expect the
   *     gate to stop things it cannot.
   *
   * The alternative -- say nothing -- is what makes this class of bug survive,
   * because nothing anywhere surfaces the hole.
   */
  function watchRedirects(context, { userId } = {}) {
    if (!context?.on) return () => {};
    // Prune claims older than the claim TTL. Anything still unconsumed by then
    // was never the handler-first case, and leaving it would suppress a future
    // alarm on a URL the gate legitimately handled only once.
    const claimTtl = Math.max(MIN_CLAIM_TTL_MS, ungatedGraceMs * CLAIM_TTL_MULTIPLIER);
    const prune = setInterval(() => {
      const cutoff = now() - claimTtl;
      for (const [key, at] of claimed) {
        if (at < cutoff) claimed.delete(key);
      }
    }, Math.max(1000, claimTtl));
    if (typeof prune.unref === 'function') prune.unref();
    const listener = (request) => {
      try {
        const method = request?.method?.() ?? '';
        const url = request?.url?.() ?? '';
        if (!isIrreversibleMethod(method) || !isNetworkUrl(url)) return;
        const key = decisionKey(method, url);
        /**
         * Correlation, in the right direction.
         *
         * The browser fires 'request' when it commits the request; the route
         * handler runs a beat later. So the handler is the LATER party and the
         * only reliable way to match the two is time: park the event, and let
         * observe() claim it.
         *
         * The `claimed` set exists only to cover the other ordering -- the one
         * observed when a route handler somehow runs first. It is therefore
         * consumed on read and expires on its own. An earlier version kept
         * claimed entries forever, which meant the FIRST POST to a URL silenced
         * every later POST to the same URL for the life of the context: the
         * gate could be bypassed and nothing would ever be reported again.
         * That is the same class of bug this file exists to prevent, wearing the
         * costume of a fix.
         */
        if (claimed.delete(key)) {
          // Already accounted for: the handler ran before the event was
          // delivered. Counted in `suppressed` here too, so that counter means
          // "requests the gate did decide on" rather than "requests that
          // happened to arrive in the slower ordering".
          egress.suppressed += 1;
          return;
        }
        const id = `${now()}:${pendingUnclaimed.size}:${key}`;
        const timer = setTimeout(() => {
          if (!pendingUnclaimed.has(id)) return;
          pendingUnclaimed.delete(id);
          egress.detected += 1;
          egress.lastAt = now();
          const alert = {
            event: 'egress_gate_ungated_request',
            alert: EGRESS_ALERTS.UNGATED_MUTATING_REQUEST,
            userId,
            method,
            url,
            prevented: false,
            reason: 'redirect-chain-second-hop-below-route-layer',
          };
          egress.lastAlert = alert;
          try {
            log('error', 'egress gate: mutating request left with NO gate decision', alert);
          } catch {
            /* never let a logger failure hide an egress alarm */
          }
        }, ungatedGraceMs);
        if (typeof timer.unref === 'function') timer.unref();
        pendingUnclaimed.set(id, { key, timer, method, url, at: now(), userId: userId == null ? null : String(userId) });
        egress.pending = pendingUnclaimed.size;
      } catch {
        /* an introspection failure must not break the page */
      }
    };
    context.on('request', listener);
    return () => {
      clearInterval(prune);
      try {
        context.off?.('request', listener);
      } catch {
        /* context already gone */
      }
      for (const entry of pendingUnclaimed.values()) clearTimeout(entry.timer);
      pendingUnclaimed.clear();
      egress.pending = 0;
    };
  }

  function record(entry) {
    const userId = String(entry.userId ?? '');
    if (entry.ok) {
      sessions.set(userId, {
        userId,
        armedAt: entry.armedAt,
        checks: entry.checks,
        lastCheckedAt: entry.armedAt,
      });
    } else {
      sessions.delete(userId);
    }
  }

  function noteDisarmed(nextReason, detail = {}) {
    const first = state !== STATES.DISARMED;
    state = STATES.DISARMED;
    reason = nextReason;
    reasonDetail = detail;
    if (first) since = now();
    try {
      log('error', 'egress gate DISARMED', {
        event: 'egress_gate_disarmed',
        armed: false,
        reason: nextReason,
        ...detail,
      });
    } catch {
      /* a broken logger must not be able to hide a disarm */
    }
  }

  /**
   * Prove the handler is running by issuing one real request through the real
   * context and waiting for the handler to report seeing its token.
   *
   * Returns { ok, checks }. Never throws for a plain "not seen": a failed
   * canary is a state, and turning it into an exception here would mean the
   * caller had to distinguish, which is how a disarmed gate gets written to log
   * a warning and carry on.
   */
  async function runCanary(context, token) {
    canary.attempts += 1;
    canary.lastToken = token;
    canary.lastAt = now();

    const marker = token;
    const baseline = handler.invocations;
    const url = `http://${CANARY_HOST}/__egress_gate_canary__?token=${token}`;

    let page = null;
    let probeError = null;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: canaryTimeoutMs, waitUntil: 'commit' }).catch((err) => {
        // Expected: .invalid does not resolve. Recorded so that an UNEXPECTED
        // navigation failure (a dead context, say) is distinguishable from the
        // designed-for one.
        probeError = err?.message ?? String(err);
      });
    } catch (err) {
      probeError = err?.message ?? String(err);
    } finally {
      await page?.close().catch(() => {});
    }

    // Give the dispatcher a beat to land the handler if it is going to. The
    // page.goto rejection above is already a completed round trip through the
    // route dispatcher, so this only absorbs scheduling jitter.
    const deadline = now() + Math.min(canaryTimeoutMs, 1000);
    while (handler.invocations <= baseline && now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const seen = handler.invocations > baseline;
    // Membership, not lastUrl: see the note in observe(). Exact URL match on the
    // canary's own URL, which is unique per token.
    const sawToken = seen && handler.seenUrls.has(url);
    const ok = Boolean(sawToken);

    if (ok) {
      canary.passed += 1;
    } else {
      canary.failed += 1;
    }
    canary.lastResult = ok ? CHECKS.OK : CHECKS.FAILED;

    return {
      ok,
      checks: {
        canary: ok ? CHECKS.OK : seen ? CHECKS.FAILED : CHECKS.FAILED,
        // Recorded so the operator can tell "the handler ran but for another
        // request" from "the handler never ran at all".
        canarySawHandler: seen,
        canarySawToken: Boolean(sawToken),
      },
      detail: { probeError, url },
    };
  }

  /**
   * Arm one context. Throws GateDisarmedError when the gate cannot be proven
   * live on it, so that the caller has to decide what to do about a session it
   * cannot protect -- and the decision made here is "refuse to run it".
   */
  async function arm(context, { userId } = {}) {
    if (!enabled) {
      state = STATES.DISARMED;
      reason = 'gate-disabled';
      return { armed: false, disabled: true };
    }
    const token = randomUUID();
    const armedAt = now();
    let ourHandler = null;
    let unwatch = () => {};

    const guard = () => (inner) =>
      guardHandler(inner, {
        onError: (err) => {
          handler.errors += 1;
          handler.lastError = { message: err?.message ?? String(err), at: now() };
          noteDisarmed(DISARM_REASONS.HANDLER_ERRORED, { userId });
        },
      });

    try {
      ourHandler = await gate.installOnContext(context, {
        userId,
        sessionKey: userId,
        wrap: guard(),
      });
    } catch (err) {
      installFailures += 1;
      noteDisarmed(DISARM_REASONS.INSTALL_THREW, {
        userId,
        error: err?.message ?? String(err),
      });
      throw new GateDisarmedError(DISARM_REASONS.INSTALL_THREW, {
        userId,
        error: err?.message ?? String(err),
      });
    }

    if (ourHandler === false || ourHandler === null || ourHandler === undefined) {
      // installOnContext returning falsy means it declined to install (already
      // routed). That is legitimate for a repeat call and illegitimate for the
      // first, and only the caller knows which this is -- so the canary decides.
      record({ userId, ok: false, armedAt, checks: {} });
    }

    // Installed only after the HTTP route is proven, and independently
    // fail-closed: if this throws, the context is torn down rather than left
    // running with handshakes ungated, because "the gate refused to install"
    // must not degrade to "the gate quietly covers less than it says".
    let wsHandler = null;
    let wsInstallError = null;
    try {
      wsHandler = await gate.installWebSocketRoute?.(context, {
        userId,
        sessionKey: userId,
        wrap: guard(),
      });
    } catch (err) {
      wsInstallError = err?.message ?? String(err);
    }

    const probe = await runCanary(context, token);
    const structural = ourHandler ? routePresence(context, ourHandler) : CHECKS.UNAVAILABLE;

    if (wsInstallError) {
      record({ userId, ok: false, armedAt, checks: { ...probe.checks, websocket: CHECKS.FAILED } });
      noteDisarmed('websocket-install-threw', { userId, error: wsInstallError });
      throw new GateDisarmedError('websocket-install-threw', { userId, error: wsInstallError });
    }

    const checks = {
      install: CHECKS.OK,
      // 'ok' when a handler was registered, 'unavailable' when this
      // playwright-core build has no routeWebSocket -- reported as unknown, not
      // as covered, so an upgrade that drops the API cannot quietly shrink the
      // gate's real coverage while the snapshot keeps saying armed.
      websocket: wsHandler === false ? CHECKS.UNAVAILABLE : CHECKS.OK,
      ...probe.checks,
      // A structural read of 'absent' after a passing canary means the table
      // changed between the two reads. Trusting the canary is the documented
      // order: it is the behavioural instrument.
      route: probe.ok ? structural : CHECKS.FAILED,
    };

    if (!probe.ok) {
      const why = probe.checks.canarySawHandler
        ? DISARM_REASONS.CANARY_NOT_SEEN
        : DISARM_REASONS.CANARY_TIMED_OUT;
      record({ userId, ok: false, armedAt, checks });
      noteDisarmed(why, { userId, ...probe.detail });
      throw new GateDisarmedError(why, { userId, ...probe.detail });
    }

    // Attached only after the canary proves the route intercepts, so the
    // detector's own view of the context is not asked to explain a route that
    // was never there.
    unwatch = watchRedirects(context, { userId });
    if (userId != null) unwatchers.set(String(userId), unwatch);

    record({ userId, ok: true, armedAt, checks });
    if (state !== STATES.DISARMED) {
      state = STATES.ARMED;
      since = armedAt;
      reason = null;
      reasonDetail = null;
    }
    try {
      log('info', 'egress gate armed', {
        event: 'egress_gate_armed',
        armed: true,
        userId,
        checks,
        canaryToken: token,
      });
    } catch {
      /* logging the arm is best-effort; the state is the record */
    }
    return { armed: true, userId, checks, armedAt, canaryToken: token };
  }

  /**
   * One watchdog pass. Exposed (rather than only reachable by the timer) so it
   * can be driven deterministically by a test instead of by wall-clock luck.
   */
  async function check({ reason: trigger = 'interval' } = {}) {
    lastTickAt = now();
    const findings = [];

    for (const [userId, entry] of [...sessions]) {
      const session = lookupSession(userId);
      // A session the gate can no longer see is destroyed HERE, not left for a
      // later enforce() call: dropping the tracking entry first would leave the
      // server holding a context the gate has stopped accounting for, which is
      // the fail-open shape this whole file exists to prevent.
      if (!session?.context) {
        sessions.delete(userId);
        findings.push({ userId, check: 'session', result: CHECKS.DEAD });
        noteDisarmed(DISARM_REASONS.CONTEXT_DEAD, { userId });
        await teardown(userId);
        continue;
      }

      let alive = true;
      try {
        session.context.pages();
      } catch {
        alive = false;
      }
      if (!alive) {
        sessions.delete(userId);
        findings.push({ userId, check: 'context', result: CHECKS.DEAD });
        noteDisarmed(DISARM_REASONS.CONTEXT_DEAD, { userId });
        await teardown(userId);
        continue;
      }

      if (deepProbe) {
        const probe = await runCanary(session.context, randomUUID());
        if (!probe.ok) {
          findings.push({ userId, check: 'canary', result: CHECKS.FAILED });
          noteDisarmed(DISARM_REASONS.CANARY_TIMED_OUT, { userId, ...probe.detail });
          continue;
        }
      }

      entry.lastCheckedAt = lastTickAt;
      entry.checks = { ...entry.checks, context: CHECKS.ALIVE, ...(deepProbe ? { canary: CHECKS.OK } : {}) };
    }

    return { ok: state !== STATES.DISARMED, trigger, findings, checkedAt: lastTickAt };
  }

  /**
   * Fail closed, made structural: a context the gate cannot account for is torn
   * down rather than flagged. Called by index.js whenever a disarm happens, and
   * by the watchdog when it can name the user whose context is affected.
   */
  async function enforce({ userId } = {}) {
    const targets = userId != null ? [String(userId)] : [...sessions.keys()];
    const torn = [];
    for (const id of targets) {
      if (await teardown(id)) torn.push(id);
      sessions.delete(id);
    }
    return torn;
  }

  /**
   * Release one session: detach the redirect watcher (it holds timers keyed to a
   * context that is about to stop existing, and a late fire would alarm about a
   * session we tore down on purpose), drop its pending timers, then destroy it.
   * Returns whether the teardown was attempted, which is the honest answer: a
   * destroySession that throws still counts, because the alternative is leaving
   * the session alive and calling that a failure to report.
   */
  async function teardown(id) {
    try {
      unwatchers.get(id)?.();
    } catch {
      /* nothing to detach */
    }
    unwatchers.delete(id);
    for (const [pid, entry] of pendingUnclaimed) {
      if (entry.userId === id) {
        clearTimeout(entry.timer);
        pendingUnclaimed.delete(pid);
      }
    }
    egress.pending = pendingUnclaimed.size;
    try {
      await destroySession(id, { reason: 'egress_gate_disarmed' });
    } catch {
      return true;
    }
    return true;
  }

  /** Detach and forget a session's redirect watcher without tearing it down. */
  function forget(userId) {
    const id = String(userId);
    try {
      unwatchers.get(id)?.();
    } catch {
      /* nothing to detach */
    }
    unwatchers.delete(id);
    sessions.delete(id);
    for (const [pid, entry] of pendingUnclaimed) {
      if (entry.userId === id) {
        clearTimeout(entry.timer);
        pendingUnclaimed.delete(pid);
      }
    }
    egress.pending = pendingUnclaimed.size;
  }

  function watchdogStalled() {
    if (!watchdog || lastTickAt == null) return false;
    return now() - lastTickAt > watchdogIntervalMs * WATCHDOG_STALE_AFTER_TICKS;
  }

  /**
   * The machine-readable snapshot. Every key here is a contract: an operator,
   * a health check or a test branches on these values, so they are stable,
   * typed and never carry prose.
   */
  function snapshot() {
    const stalled = watchdogStalled();
    const armed = enabled && state === STATES.ARMED && !stalled && installFailures === 0;
    let armedSessions = 0;
    for (const entry of sessions.values()) if (entry.checks?.canary === CHECKS.OK) armedSessions += 1;

    return {
      armed,
      state: enabled ? state : STATES.DISARMED,
      reason: reason ?? (stalled ? DISARM_REASONS.WATCHDOG_STALLED : null),
      since,
      // The word "armed" arrives with its limits attached. A consumer that reads
      // only `armed` still learns what it does not cover, from this process, at
      // the moment it asks.
      scope: SCOPE,
      sessionCount: sessions.size,
      armedSessionCount: armedSessions,
      // Every session the gate has ever armed and not yet torn down. A
      // non-empty list with armedSessionCount === 0 is the exact shape of a
      // gate that installed nothing.
      sessions: [...sessions.values()].map((e) => ({
        userId: e.userId,
        armedAt: e.armedAt,
        lastCheckedAt: e.lastCheckedAt,
        checks: e.checks,
      })),
      canary: {
        attempts: canary.attempts,
        passed: canary.passed,
        failed: canary.failed,
        lastAt: canary.lastAt,
        lastResult: canary.lastResult,
      },
      handler: {
        invocations: handler.invocations,
        errors: handler.errors,
        lastSeenAt: handler.lastSeenAt,
      },
      /**
       * Redirect-chain egress that got past the route. Reported separately from
       * `armed` on purpose: it does not mean the route stopped working, it means
       * the route was not the layer involved. `detected` counts incidents,
       * `prevented` is always 0 and is published so nobody has to infer the
       * absence of prevention from its absence in the output.
       */
      egress: {
        detected: egress.detected,
        prevented: 0,
        suppressed: egress.suppressed,
        pending: pendingUnclaimed.size,
        lastDetectedAt: egress.lastAt,
        lastAlert: egress.lastAlert,
      },
      watchdog: {
        running: Boolean(watchdog),
        intervalMs: watchdogIntervalMs,
        lastTickAt,
        fresh: !stalled,
        deepProbe,
      },
      checks: {
        installFailures,
        handlerErrored: handler.errors > 0 ? CHECKS.FAILED : CHECKS.OK,
        canaryPassed: canary.failed === 0 && canary.attempts > 0 ? CHECKS.OK : canary.lastResult ?? CHECKS.NONE,
        watchdog: !watchdog ? CHECKS.SKIPPED : stalled ? CHECKS.STALE : CHECKS.FRESH,
      },
    };
  }

  function startWatchdog() {
    if (!enabled || watchdog) return;
    lastTickAt = now();
    watchdog = setInterval(() => {
      check().catch((err) => {
        noteDisarmed(DISARM_REASONS.WATCHDOG_STALLED, { error: err?.message ?? String(err) });
      });
    }, watchdogIntervalMs);
    if (typeof watchdog.unref === 'function') watchdog.unref();
  }

  function stopWatchdog() {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  }

  return {
    STATES,
    arm,
    check,
    observe,
    snapshot,
    startWatchdog,
    stopWatchdog,
    watchdogStalled,
    /** True when a specific user's context is armed. Undefined user => global. */
    isArmed(userId) {
      const snap = snapshot();
      if (userId == null) return snap.armed;
      return snap.armed && sessions.has(String(userId));
    },
    enforce,
    forget,
    watchRedirects,
  };
}
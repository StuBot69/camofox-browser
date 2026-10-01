/**
 * THE GATE. Where the policy meets a live Playwright route.
 *
 * This is the only place that calls route.continue() or route.abort(), and its
 * one hard obligation is: EVERY request ends in EXACTLY ONE of them. A route
 * left hanging hangs the page it belongs to, which presents to whoever is
 * driving the browser as "camofox is broken" rather than "the gate swallowed an
 * error", and the fix everybody reaches for is turning the gate off. So the
 * resolve is idempotent and the handler never lets an exception escape into
 * Playwright's route dispatcher.
 *
 * INSTALLED ON THE CONTEXT, NOT THE PAGE, AND WHY. Playwright gives both
 * context.route() and page.route(). Installing both means two handlers can
 * match one request and the winner is decided by Playwright's registration
 * order rather than by this code -- so whether a given mutation gets gated
 * twice, once, or not at all would depend on a detail nobody would think to
 * look at. One handler, installed once per BrowserContext, is the only version
 * of this whose coverage can be stated in one sentence:
 *
 *   Every request initiated in this user's context, including pages created
 *   later, popups, and the first navigation -- EXCLUDING the follow-up hop of a
 *   307/308 redirect chain (which is DETECTED via watchRedirects() /
 *   context.on('request') but NOT prevented, as it is issued below context.route()),
 *   and with WebSocket handshakes gated via context.routeWebSocket().
 *
 * That redirect exclusion is measured, not theoretical. `measure_redirect_handler.mjs`
 * records a 307's second POST arriving at the server carrying the card body and
 * the session cookie with ZERO entries in this handler, so policy.grantCovers()
 * was never consulted for it; the hop is issued below the interception layer.
 * Playwright does not promise redirect coverage on the route API, so this module
 * cannot deliver prevention. Instead, watchRedirects() runs at the same lifecycle
 * point as context.route(), detecting ungated hops and recording them in the
 * audit. See ./armed.js for the runtime detection mechanics and the scope string
 * this gate reports.
 *
 * The page-level hook the brief asks for ("install per page at creation, not per
 * click") is satisfied by the same property: the handler is installed ONCE at
 * context creation and never re-installed per click, which is where the
 * per-click latency would otherwise come from. tabId is recovered for the audit
 * by reverse lookup from the live session map rather than by a second route.
 */

import { describeRequest, decide, REASONS } from './policy.js';

/**
 * Describe a WebSocket handshake for the policy, WITHOUT touching policy.js.
 *
 * policy.js and approval.js are the brief's verbatim port and 72 tests of trusted
 * logic. Adding a branch to them to accommodate WebSocket would mean the thing
 * whose correctness is being trusted is also the thing being edited to fit a new
 * transport. So the adaptation lives here instead, in the adapter whose whole job
 * is translating a live Playwright object into what the policy already accepts:
 *
 *   - ws:// and wss:// are rewritten to http:// and https://, because
 *     isNetworkUrl() recognises only http/https and would otherwise treat a real
 *     remote socket as having nowhere to go and fall through unexamined.
 *   - the method is forced to GET, which is what the handshake actually is on the
 *     wire, so an approval the human granted for this URL is honoured.
 *   - `alwaysGate` is set. decide() only asks for approval on irreversible
 *     methods, and GET would sail through -- but a GET that upgrades into a
 *     bidirectional channel can carry a mutation and Playwright gives us no way to
 *     inspect frames after the handshake. Refusing to reason about what is inside
 *     is the only choice that does not assume safety.
 *
 * @param {string} rawUrl
 * @returns {{method: string, url: string, alwaysGate: boolean, resourceType: string}}
 */
/**
 * The decide() decision for a handshake.
 *
 * describeWebSocket() sets alwaysGate, and decide() (untouched, 72 tests) has no
 * notion of that flag -- it returns allow for any GET. So the alwaysGate case is
 * resolved here, in the adapter, by running decide() on a POST instead and
 * reporting the reason as the policy would for a not-yet-approved mutation.
 * That reuses grantCovers() for the grant lookup, which is the part that must
 * match HTTP exactly, without editing the file the brief froze.
 */
function decideWebSocket(described, { grants }) {
  if (!described.alwaysGate) return decide(described, { grants });
  return decide({ ...described, method: 'POST' }, { grants });
}

export function describeWebSocket(rawUrl) {
  const url = String(rawUrl ?? '')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://');
  return {
    method: 'GET',
    url,
    alwaysGate: true,
    resourceType: 'websocket',
    // No frames are inspectable at handshake time, so there is nothing to
    // fingerprint. Null rather than a placeholder: an audit row carrying a fake
    // fingerprint is worse than one admitting there was nothing to hash.
    fingerprint: null,
    isNavigation: false,
    postData: null,
  };
}

/**
 * Wrap a resolve so it can be called twice safely and the second call is
 * ignored. Playwright's own complaint on a double-resolve is a rejected promise
 * inside the page's request, which surfaces as a page error nobody can trace
 * back here.
 */
function onceOnly(resolve, kind, onSecond) {
  let done = false;
  return async function resolveOnce() {
    if (done) {
      onSecond?.();
      return;
    }
    done = true;
    try {
      await resolve(kind);
    } catch {
      // The page may already be gone (tab destroyed mid-decision). There is no
      // third option to take and nothing left to unblock, so this is swallowed
      // on purpose rather than rethrown into an unawaited handler.
    }
  };
}

export function createEgressGate({
  approval,
  audit,
  resolveTabId = () => ({ tabId: null }),
  log = () => {},
  now = () => Date.now(),
  watchRedirects: initialWatchRedirects = null,
  stats = {
    allowed: 0,
    refused: 0,
    asked: 0,
    allowedSilent: 0,
    doubleResolveAttempts: 0,
    // Counted apart from allowed/refused so a WebSocket decision can never be
    // mistaken for an HTTP one in a stats scrape.
    wsAllowed: 0,
    wsRefused: 0,
  },
} = {}) {
  if (!approval || !audit) throw new Error('createEgressGate requires approval and audit');

  /**
   * Set by index.js so a context's routes can be unregistered on teardown. */
  const routedContexts = new WeakSet();
  /** Separate set: a context can be HTTP-routed and not WS-routed, or vice versa. */
  const wsRoutedContexts = new WeakSet();

  /**
   * Observability hook. Set by ./armed.js, which needs evidence that THIS
   * handler ran -- the only assertion that a Playwright route is really
   * intercepting rather than merely registered. Reports every request the
   * handler sees, including the silently-allowed ones, because "the gate ran at
   * all" is a fact about the handler and not about any particular decision.
   * Absent by default so the gate has no hard dependency on armed.js.
   */
  let observe = () => {};

  /**
   * Redirect detection hook. Set by ./armed.js so that watchRedirects()
   * is installed at the same lifecycle point as context.route() (session:created,
   * before the first page exists).
   */
  let watchRedirects = typeof initialWatchRedirects === 'function' ? initialWatchRedirects : null;

  async function handle({ route, request, userId, sessionKey }) {
    const url = (() => {
      try {
        return request?.url?.() ?? '';
      } catch {
        return '';
      }
    })();
    const described = describeRequest(request);

    // Evidence that this handler ran on this request. Deliberately BEFORE the
    // first branch, including the non-network shortcut: an armed-state
    // assertion that only counted gated decisions would be blind to the case
    // where the handler is reached but the policy is not consulted, which is a
    // silent disarm with extra steps.
    try {
      observe({ method: described.method, url: described.url });
    } catch {
      /* observation must never change a decision or hang a request */
    }

    // Abort/continue exactly once, whichever path we take below.
    const allow = onceOnly(() => route.continue(), 'allow', () => {
      stats.doubleResolveAttempts += 1;
    });
    const refuse = onceOnly(() => route.abort(), 'refuse', () => {
      stats.doubleResolveAttempts += 1;
    });

    // Anything that is not http/https has no server to gate: about:blank has no
    // origin, data: and blob: are object references into this process's memory.
    // Recorded as a count, not as a decision, because no egress happened.
    if (!/^https?:/i.test(url)) {
      await allow();
      return;
    }

    const { tabId } = resolveTabId({ userId, sessionKey, request });
    const describedWithTab = { ...described, tabId };
    const base = {
      userId,
      sessionKey,
      tabId,
      resourceType: described.resourceType,
      isNavigation: described.isNavigation,
      fingerprint: described.fingerprint,
    };

    const grants = approval.listGrants(sessionKey);
    const decision = decide(described, { grants });

    if (decision.action === 'allow') {
      stats.allowed += 1;
      // The known-safe set is allowed SILENTLY. It is a count, not an audit
      // entry: the audit is for irreversible decisions, and a log where every
      // asset load is a row is a log nobody reads.
      if (decision.reason === REASONS.SAFE_METHOD) {
        stats.allowedSilent += 1;
        await allow();
        return;
      }
      audit.record({
        ...base,
        method: described.method,
        url: described.url,
        decision: 'allowed',
        reason: decision.reason,
        approvalId: decision.grant?.approvalId ?? null,
        grantedScope: decision.grant?.scope ?? null,
      });
      await allow();
      return;
    }

    // --- the irreversible class -------------------------------------------------
    stats.asked += 1;

    if (!approval.available()) {
      stats.refused += 1;
      audit.record({
        ...base,
        method: described.method,
        url: described.url,
        decision: 'refused',
        reason: REASONS.APPROVAL_UNAVAILABLE,
      });
      await refuse();
      return;
    }

    const askedAt = now();
    let outcome;
    try {
      outcome = await approval.ask(
        {
          method: described.method,
          url: described.url,
          userId,
          sessionKey,
          tabId,
          resourceType: described.resourceType,
          isNavigation: described.isNavigation,
          fingerprint: described.fingerprint,
          postData: described.postData,
        },
        { timeoutMs: approval.timeoutMs },
      );
    } catch (err) {
      // Fail closed on an exception in the approval machinery. There is no
      // argument for allowing here: an approval path that threw has not
      // approved anything.
      stats.refused += 1;
      log('error', 'egress gate approval path errored, refusing', {
        method: described.method,
        url: described.url,
        error: err?.message,
      });
      audit.record({
        ...base,
        method: described.method,
        url: described.url,
        decision: 'refused',
        reason: REASONS.APPROVAL_ERRORED,
        waitedMs: now() - askedAt,
      });
      await refuse();
      return;
    }

    const waitedMs = now() - askedAt;

    if (outcome?.allowed) {
      stats.allowed += 1;
      audit.record({
        ...base,
        method: described.method,
        url: described.url,
        decision: 'allowed',
        reason: outcome.reason ?? REASONS.APPROVED,
        approvalId: outcome.approvalId ?? null,
        grantedScope: outcome.grant?.scope ?? null,
        waitedMs,
      });
      await allow();
      return;
    }

    stats.refused += 1;
    audit.record({
      ...base,
      method: described.method,
      url: described.url,
      decision: 'refused',
      reason: outcome?.reason ?? REASONS.APPROVAL_ERRORED,
      waitedMs,
    });
    log('info', 'egress gate refused an irreversible request', {
      method: described.method,
      url: described.url,
      reason: outcome?.reason,
      tabId,
      waitedMs,
    });
    await refuse();
  }

  function resolveTabOf({ userId, request }) {
    try {
      return request?.frame?.()?.page?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Install the single enforcement point on a BrowserContext. Registered once,
   * at context creation, never per click.
   *
   * Returns the handler actually registered on the context, or false when this
   * context was already routed. The return value is what lets ./armed.js prove
   * the route is present by identity instead of trusting that route() resolved:
   * a handler reference is checkable, "it didn't throw" is not.
   *
   * `wrap` lets armed.js put an error guard around the handler without this
   * module knowing what a guard is.
   */
  async function installOnContext(context, { userId, sessionKey, wrap } = {}) {
    if (!context?.route) throw new Error('installOnContext requires a BrowserContext');
    if (routedContexts.has(context)) return false;
    routedContexts.add(context);
    const key = String(sessionKey ?? userId ?? 'default');
    const raw = async (route, request) => {
      await handle({ route, request, userId, sessionKey: key });
    };
    const registered = typeof wrap === 'function' ? wrap(raw) : raw;
    try {
      await context.route('**/*', registered);
    } catch (err) {
      routedContexts.delete(context);
      throw err;
    }
    // Wire redirect detection at the same lifecycle point as context.route(),
    // before the first page exists.
    if (typeof watchRedirects === 'function') {
      watchRedirects(context, { userId });
    }
    return registered;
  }

  /**
   * Same policy, second transport.
   *
   * A WebSocket handshake is a GET, so context.route() does not see it -- not as
   * a refusal, simply never. measure_websocket_gate.mjs records the server
   * receiving GET /ws with zero entries in the route handler, and Playwright
   * provides routeWebSocket() on the same context, which DOES intercept here.
   *
   * The policy vocabulary does not fit perfectly and the mismatch is handled
   * rather than papered over: a handshake is presented to decide() as the method
   * GET with the ws:// scheme rewritten to http://, so isNetworkUrl() sees it.
   * It is then forced irreversible, because a GET that upgrades into a
   * bidirectional channel can carry a mutation and there is no way to inspect
   * frames after the fact. The user-visible effect is that every WebSocket is
   * approval-gated, which is stricter than the HTTP rule but is the only reading
   * of "an uninspectable mutating channel" that does not assume safety.
   *
   * Returns the handler, or false when already installed, mirroring
   * installOnContext so armed.js can treat both the same way.
   */
  async function installWebSocketRoute(context, { userId, sessionKey, wrap } = {}) {
    if (typeof context?.routeWebSocket !== 'function') return false;
    if (wsRoutedContexts.has(context)) return false;
    wsRoutedContexts.add(context);
    const key = String(sessionKey ?? userId ?? 'default');
    const raw = async (ws) => {
      const described = describeWebSocket(String(ws?.url?.() ?? ''));
      const tabId = null;
      const base = {
        method: described.method,
        url: described.url,
        sessionKey: key,
        userId,
        tabId,
        resourceType: described.resourceType,
        fingerprint: described.fingerprint,
        transport: 'websocket',
      };
      // Every handshake ends in exactly one of connectToServer() or close(),
      // for the same reason every HTTP route does: an unresolved socket hangs
      // whatever opened it, and that reads as "camofox is broken".
      const allow = async (outcome = {}) => {
        stats.wsAllowed += 1;
        audit.record({
          ...base,
          decision: 'allowed',
          reason: outcome.reason ?? REASONS.APPROVED,
          approvalId: outcome.approvalId ?? null,
          grantedScope: outcome.grant?.scope ?? outcome.scope ?? null,
        });
        try {
          ws.connectToServer();
        } catch (err) {
          // connectToServer throwing leaves the socket unresolved, which is the
          // one outcome worse than a refusal.
          try {
            ws.close({ code: 1011, reason: 'egress gate: connect failed' });
          } catch {
            /* already gone */
          }
          log('error', 'egress gate websocket connect failed', {
            url: described.url,
            error: err?.message ?? String(err),
          });
          return;
        }
        // MEASURED, NOT ASSUMED: on Camoufox/Firefox with playwright-core 1.59.1,
        // connectToServer() resolves and the server NEVER sees the handshake --
        // an intercepted socket with no server on the other end. playwright's own
        // client swallows the failure (network.js: `this._channel.connect().catch(...)`),
        // so "it did not throw" is not evidence that the socket connected, which
        // is the same reason this file refuses to trust route() resolving.
        //
        // The consequence is stated rather than papered over: WebSocket
        // handshakes are REFUSED here, including approved ones, because allowing
        // them would present a socket the page believes is connected and that has
        // no server behind it. Refusing is loud and diagnosable; a phantom
        // connected socket is neither.
        log('warn', 'egress gate refused an approved websocket: pass-through unsupported on this engine', {
          url: described.url,
          event: 'egress_gate_websocket_passthrough_unsupported',
          approved: true,
        });
        try {
          ws.close({ code: 1008, reason: 'websocket pass-through unsupported on this engine' });
        } catch {
          /* already gone */
        }
      };
      const refuse = async (reason, extra = {}) => {
        stats.wsRefused += 1;
        audit.record({ ...base, decision: 'refused', reason, ...extra });
        log('info', 'egress gate refused a websocket handshake', {
          url: described.url,
          reason,
          tabId,
        });
        try {
          ws.close({ code: 1008, reason: 'egress gate refused' });
        } catch {
          /* the socket is already gone */
        }
      };

      try {
        observe({ method: described.method, url: described.url });
      } catch {
        /* observation must never change a decision */
      }

      const decision = decideWebSocket(described, { grants: approval.listGrants(key) });
      if (decision.action === 'allow') {
        await allow();
        return;
      }

      // An unapproved handshake is asked about, on the same approval surface the
      // HTTP path uses, so a human sees one queue rather than two.
      stats.asked += 1;
      if (!approval.available()) {
        await refuse(REASONS.APPROVAL_UNAVAILABLE);
        return;
      }
      let outcome;
      try {
        outcome = await approval.ask(
          { ...base, postData: null, isNavigation: false },
          { timeoutMs: approval.timeoutMs },
        );
      } catch (err) {
        // Fail closed on an exception in the approval machinery. An approval path
        // that threw has not approved anything.
        await refuse(REASONS.APPROVAL_ERRORED, { error: err?.message ?? String(err) });
        return;
      }
      // approval.settle() resolves with { allowed, scope } or { allowed: false,
      // reason }. `allowed` is the field; an earlier version of this handler read
      // `outcome.approved`, which never exists, so every approved socket was
      // refused. The refusal was fail-closed, which is why it did not look like
      // a crash -- it looked like a gate that was slightly too strict.
      if (outcome?.allowed) {
        await allow(outcome);
        return;
      }
      await refuse(outcome?.reason ?? REASONS.APPROVAL_DENIED);
    };
    const registered = typeof wrap === 'function' ? wrap(raw) : raw;
    try {
      await context.routeWebSocket('**/*', registered);
    } catch (err) {
      wsRoutedContexts.delete(context);
      throw err;
    }
    return registered;
  }

  return {
    handle,
    installOnContext,
    installWebSocketRoute,
    resolveTabOf,
    stats,
    audit,
    /** @internal set by ./armed.js */
    setObserver(fn) {
      observe = typeof fn === 'function' ? fn : () => {};
    },
    /** @internal set by ./armed.js or custom watcher */
    setRedirectWatcher(fn) {
      watchRedirects = typeof fn === 'function' ? fn : null;
    },
    watchRedirects: (ctx, opts) => watchRedirects?.(ctx, opts),
  };
}
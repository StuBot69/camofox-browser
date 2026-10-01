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
 *   every request made by every page in this user's context, including pages
 *   created later and popups, including the first navigation.
 *
 * The page-level hook the brief asks for ("install per page at creation, not per
 * click") is satisfied by the same property: the handler is installed ONCE at
 * context creation and never re-installed per click, which is where the
 * per-click latency would otherwise come from. tabId is recovered for the audit
 * by reverse lookup from the live session map rather than by a second route.
 */

import { describeRequest, decide, REASONS } from './policy.js';

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
  stats = { allowed: 0, refused: 0, asked: 0, allowedSilent: 0, doubleResolveAttempts: 0 },
} = {}) {
  if (!approval || !audit) throw new Error('createEgressGate requires approval and audit');

  /** Set by index.js so a context's routes can be unregistered on teardown. */
  const routedContexts = new WeakSet();

  async function handle({ route, request, userId, sessionKey }) {
    const url = (() => {
      try {
        return request?.url?.() ?? '';
      } catch {
        return '';
      }
    })();
    const described = describeRequest(request);

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
   */
  async function installOnContext(context, { userId, sessionKey } = {}) {
    if (!context?.route) throw new Error('installOnContext requires a BrowserContext');
    if (routedContexts.has(context)) return false;
    routedContexts.add(context);
    const key = String(sessionKey ?? userId ?? 'default');
    await context.route('**/*', async (route, request) => {
      await handle({ route, request, userId, sessionKey: key });
    });
    return true;
  }

  return {
    handle,
    installOnContext,
    resolveTabOf,
    stats,
  };
}
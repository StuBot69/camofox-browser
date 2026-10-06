/**
 * THE APPROVAL SURFACE, and the fail-closed rule that makes it safe.
 *
 * A NOTE ON WHY THIS FILE EXISTS. The brief for this work states that the
 * approval machinery is "already in the server (auth(), the approval
 * request/settle helpers, the event bus)" and instructs me to use what exists.
 * Measured on this repo at commit e5a36f5:
 *
 *   - the event bus exists (lib/plugins.js, a Node EventEmitter + emitAsync);
 *   - auth() exists, but it is Bearer-token middleware -- it authenticates the
 *     CALLER of the HTTP API and has nothing to do with a human approving an
 *     action;
 *   - there is no approval request object, no settle helper, no waiter, no
 *     timeout, and no notion of an approval already granted for a session.
 *     `git log --all -S approval` finds only prose in a comment.
 *
 * So the request/settle half of the surface is built here rather than reused.
 * The event bus IS reused (index.js emits on it), and the ruling is unchanged:
 * POST/PUT/PATCH/DELETE never pass silently, and anything that is not a proven
 * human approval results in a refusal. What could not be done is "reuse the
 * existing approval path", because there isn't one. That is reported, not
 * papered over.
 *
 * FAIL CLOSED, in the four ways it can fail:
 *   1. the gate is disabled/unavailable        -> refuse immediately
 *   2. nobody answers before the timeout        -> refuse
 *   3. a human says no                         -> refuse
 *   4. anything in here throws                  -> refuse
 * There is no path in this file that returns "allow" except an explicit
 * human approval. That is the whole point: an allow must be attributable to a
 * person, not to a fallback.
 */

import { normalizeMethod, fingerprintBody, REASONS } from './policy.js';

/**
 * Default wait for a human. Must sit well under the server's own action
 * timeout, because a page.route() handler is awaited *inside* the click's
 * withTabLock(): if the approval outlasts HANDLER_TIMEOUT_MS (30s by default)
 * the click rejects with tab_timeout and destroyTimedOutTab() tears the tab
 * down while the human is still deciding. index.js clamps to
 * handlerTimeoutMs - APPROVAL_HEADROOM_MS for that reason; this is only the
 * starting point.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 20000;

/** Settle scopes a human may choose. 'once' is the default and the tighter one. */
export const SCOPES = Object.freeze(['once', 'session']);

export function createApprovalSurface({
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  mode = 'ask',
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID(),
  log = () => {},
} = {}) {
  /**
   * The log hook is not allowed to have an opinion. A logger that throws would
   * otherwise turn every approval into a refusal, which is safe but baffling to
   * debug -- the log is the thing you read when the gate misbehaves.
   */
  function note(level, message, fields) {
    try {
      log(level, message, fields);
    } catch {
      /* a broken log is not a reason to change a decision */
    }
  }

  /** id -> pending approval awaiting a human. */
  const pending = new Map();
  /** sessionKey -> Map<grantKey, grant>. Grants are per session and per gate. */
  const grantsBySession = new Map();

  function available() {
    return mode === 'ask';
  }

  function grantsFor(sessionKey) {
    const key = String(sessionKey ?? '');
    if (!grantsBySession.has(key)) grantsBySession.set(key, new Map());
    return grantsBySession.get(key);
  }

  function grantKey(grant) {
    return `${normalizeMethod(grant.method)} ${grant.url}`;
  }

  function listGrants(sessionKey) {
    return [...grantsFor(sessionKey).values()];
  }

  /**
   * Put one irreversible request in front of a human and wait.
   *
   * Resolves to { allowed: boolean, reason, grant? }. `allowed: true` happens in
   * exactly one place: a human settled this request with approved === true.
   *
   * `timeoutMs` is a per-call override because the caller knows the server's
   * action budget for the operation that triggered the request, and the gate
   * sits inside that budget. Overriding a shared property would also be racy
   * under concurrent requests.
   */
  async function ask(request, { timeoutMs: overrideMs } = {}) {
    const waitMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : timeoutMs;

    if (!available()) {
      return { allowed: false, reason: REASONS.UNAVAILABLE_DISABLED };
    }

    const id = randomId();
    const createdAt = now();
    let settleFn = null;
    const answered = new Promise((resolve) => {
      settleFn = resolve;
    });

    const record = {
      id,
      createdAt,
      sessionKey: String(request.sessionKey ?? ''),
      userId: request.userId ?? null,
      tabId: request.tabId ?? null,
      method: normalizeMethod(request.method),
      url: request.url,
      resourceType: request.resourceType ?? null,
      isNavigation: Boolean(request.isNavigation),
      fingerprint: request.fingerprint ?? fingerprintBody(request.postData),
      deadline: createdAt + waitMs,
    };

    pending.set(id, { record, settle: settleFn, settled: false });

    note('info', 'egress gate awaiting human approval', {
      approvalId: id,
      method: record.method,
      url: record.url,
      tabId: record.tabId,
      deadline: record.deadline,
    });

    // The timer is the fail-closed backstop. It must be unref'd so a pending
    // approval never holds the process open, and cleared on every exit path.
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (entry && !entry.settled) {
        entry.settled = true;
        pending.delete(id);
        entry.settle({ allowed: false, reason: REASONS.APPROVAL_TIMEOUT });
      }
    }, waitMs);
    if (typeof timer.unref === 'function') timer.unref();

    let outcome;
    try {
      outcome = await answered;
    } catch (err) {
      outcome = { allowed: false, reason: REASONS.APPROVAL_ERRORED, error: err?.message };
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }

    if (!outcome.allowed) {
      return { allowed: false, reason: outcome.reason };
    }

    // An approval can be recorded as a session grant, so the human is asked
    // once rather than on every keystroke of the same action.
    const scope = SCOPES.includes(outcome.scope) ? outcome.scope : 'once';
    const grant = {
      method: record.method,
      url: record.url,
      scope,
      // A session grant deliberately drops the body: "this endpoint, this
      // session" is a bigger hole than "this exact payload, once", so the
      // narrower grant is only recorded when the body matches too.
      fingerprint: scope === 'session' ? { digest: null } : record.fingerprint,
      grantedAt: now(),
      approvalId: id,
    };
    // ONLY a session grant is stored for later requests.
    //
    // A 'once' grant must not be kept. It is keyed on method+url+body-digest, so
    // an identical repeat -- exactly what a retrying agent emits -- matches it
    // and is allowed with no second prompt. Consuming it after the fact was not
    // enough: decide() had already returned 'allow' before the grant was spent,
    // so the repeat went through anyway. The honest fix is that a one-time
    // approval is never a standing grant at all -- it allows the request it was
    // given for, and nothing else.
    if (scope === 'session') {
      grantsFor(record.sessionKey).set(grantKey(grant), grant);
    }

    return { allowed: true, reason: REASONS.APPROVED, grant, approvalId: id };
  }

  /**
   * A human answered. Returns false for an unknown or already-settled id, so
   * a double-click on the approve button cannot double-allow anything.
   */
  function settle(id, { approved, scope = 'once' } = {}) {
    const entry = pending.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.settle(
      approved === true
        ? { allowed: true, scope }
        : { allowed: false, reason: REASONS.APPROVAL_DENIED },
    );
    return true;
  }

  /**
   * A tab died, a session ended, or the user navigated away. Refuse anything
   * still waiting for that tab, so a pending approval cannot sit forever
   * waiting for a decision about a request whose page no longer exists.
   */
  function refuseWhere(predicate, reason = REASONS.APPROVAL_DENIED) {
    let refused = 0;
    for (const [id, entry] of [...pending]) {
      if (entry.settled) continue;
      if (!predicate(entry.record)) continue;
      entry.settled = true;
      entry.settle({ allowed: false, reason });
      refused += 1;
    }
    return refused;
  }

  function forgetSession(sessionKey) {
    grantsBySession.delete(String(sessionKey ?? ''));
  }

  function listPending() {
    return [...pending.values()]
      .filter((entry) => !entry.settled)
      .map((entry) => entry.record);
  }

  return {
    ask,
    settle,
    available,
    listPending,
    listGrants,
    refuseWhere,
    forgetSession,
    pendingCount: () => pending.size,
    mode,
    timeoutMs,
  };
}
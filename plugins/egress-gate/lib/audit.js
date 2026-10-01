/**
 * THE AUDIT LOG. Every irreversible decision, allowed or refused.
 *
 * "Always record it: method, URL, the decision, and the reason. A refused
 * mutation nobody can see later is a gate that will be 'fixed' by someone
 * switching it off."
 *
 * So this is append-only, in memory, bounded, and readable over HTTP. It is
 * intentionally NOT written to disk: an operator reading the decisions after
 * the fact is the use case, and a log file on disk becomes something people
 * rotate, ship, or delete. The cost of that choice is stated in the README --
 * decisions do not survive a restart, which is a real limit on "you can see
 * what happened".
 *
 * Bodies are never stored. See fingerprintBody() in policy.js for why.
 */

import { normalizeMethod } from './policy.js';

/** Decisions kept before the oldest are dropped. */
export const DEFAULT_AUDIT_CAPACITY = 1000;

export function createAuditLog({ capacity = DEFAULT_AUDIT_CAPACITY, now = () => Date.now() } = {}) {
  /** entries[0] is oldest. Bounded so a long session cannot exhaust memory. */
  const entries = [];
  const listeners = new Set();

  function record(entry) {
    const row = {
      at: now(),
      method: normalizeMethod(entry.method),
      url: entry.url,
      decision: entry.decision,
      reason: entry.reason,
      // Attribution. An allow must be traceable to a person; a refusal should
      // be traceable to whatever stopped it.
      approvalId: entry.approvalId ?? null,
      grantedScope: entry.grantedScope ?? null,
      waitedMs: entry.waitedMs ?? null,
      userId: entry.userId ?? null,
      tabId: entry.tabId ?? null,
      sessionKey: entry.sessionKey ?? null,
      resourceType: entry.resourceType ?? null,
      isNavigation: Boolean(entry.isNavigation),
      bodyBytes: entry.fingerprint?.bytes ?? 0,
      bodyDigest: entry.fingerprint?.digest ?? null,
      // Which transport decided this. A WebSocket handshake and an HTTP POST are
      // both "a request the gate looked at", and an operator reading a refusal
      // needs to know which one it was -- otherwise a refused socket looks like
      // a refused fetch and the audit cannot answer questions about either.
      transport: entry.transport ?? 'http',
    };
    entries.push(row);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    for (const fn of listeners) {
      try {
        fn(row);
      } catch {
        // A broken audit subscriber must never change a decision.
      }
    }
    return row;
  }

  return {
    record,
    /** Most recent first, which is the order an operator reads them in. */
    list({ limit = 100, decision } = {}) {
      let rows = entries;
      if (decision) rows = rows.filter((e) => e.decision === decision);
      return rows.slice(-limit).reverse();
    },
    size: () => entries.length,
    counts: () => ({
      total: entries.length,
      allowed: entries.filter((e) => e.decision === 'allowed').length,
      refused: entries.filter((e) => e.decision === 'refused').length,
    }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
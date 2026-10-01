/**
 * THE POLICY. One ruling, three verbs, no model.
 *
 * The owner's ruling, verbatim in substance: ASK a human for anything outside a
 * known-safe set. BLOCK everything else.
 *
 *   - GET / HEAD / OPTIONS      -> allow, silently. Navigation and asset loads
 *                                  are not irreversible and gating them makes
 *                                  the tool unusable.
 *   - POST / PUT / PATCH / DELETE, and every other method -> the irreversible
 *                                  class. NEVER allowed silently.
 *
 * WHY THIS IS A METHOD AND NOT A LIST OF WORDS. The obvious alternative is a
 * closed verb list matched against the button's label ("delete", "remove",
 * "transfer"). That is closed only against English, and the page author picks
 * the wording. A button labelled "Cancel subscription" whose onclick fires
 * fetch('/charge', {method:'POST'}) has no verb for a list to match: no form,
 * no href, and the label says cancel while the effect says charge. Every
 * synonym is a hole that opens silently when somebody changes a button.
 *
 * The REQUEST is the signal, and it is checked at the moment of egress, in
 * page.route(), before the bytes leave. Nothing upstream of the request is
 * trusted -- not the DOM, not the label, not the actor's own description of
 * what it is about to do. There is no model in this loop: no verdict, no
 * confidence, no severity. A method is a method.
 *
 * This module is deliberately pure. crypto is deterministic and the only
 * import; there is no I/O, no clock, and no Playwright object, so the whole
 * policy is testable without a browser. The route handler that installs this on
 * a page lives in ../index.js and does nothing but call decide() and then
 * resolve the request exactly once.
 */

import { createHash } from 'node:crypto';

/**
 * The known-safe set. Everything NOT in here is the irreversible class --
 * including methods nobody has heard of, which is the safe direction for an
 * unknown verb. A made-up verb is not evidence of safety.
 */
export const SAFE_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

const SAFE_METHOD_SET = new Set(SAFE_METHODS);

/**
 * Reasons are recorded verbatim in the audit. They are machine-readable on
 * purpose: "why was this allowed" must be answerable later without reading the
 * code, and a refused mutation nobody can see is a gate that gets switched off.
 */
export const REASONS = Object.freeze({
  SAFE_METHOD: 'safe-method',
  APPROVED: 'irreversible-approved',
  UNAPPROVED: 'irreversible-unapproved',
  NOT_NETWORK: 'not-a-network-url',
  APPROVAL_UNAVAILABLE: 'approval-path-unavailable',
  APPROVAL_TIMEOUT: 'approval-timeout',
  APPROVAL_DENIED: 'denied-by-human',
  APPROVAL_ERRORED: 'approval-path-errored',
  UNAVAILABLE_DISABLED: 'gate-unavailable-gate-disabled',
});

export function normalizeMethod(method) {
  return String(method ?? '').trim().toUpperCase();
}

export function isSafeMethod(method) {
  return SAFE_METHOD_SET.has(normalizeMethod(method));
}

/** Anything outside the known-safe set. Includes unknown/custom verbs. */
export function isIrreversibleMethod(method) {
  return !isSafeMethod(method);
}

/**
 * Only http/https leave the machine as a request this gate can see a method
 * for. about:blank, data: and blob: URLs have no server to gate, and blob:
 * requests are object references into memory. Failing these open is NOT a hole
 * in the policy -- there is no egress to stop -- but it is a hole in the
 * coverage, and it is written down in the README rather than left implied.
 */
export function isNetworkUrl(url) {
  const raw = String(url ?? '');
  const lowered = raw.toLowerCase();
  return lowered.startsWith('http://') || lowered.startsWith('https://');
}

/**
 * Body fingerprint for audit records.
 *
 * Deliberately NOT the body. A POST body is routinely a session token, a card
 * number, a password reset code or an OAuth code. Writing that to an audit log
 * would make the log the most sensitive file on the disk, and the gate's whole
 * argument is that an operator can look at the log afterwards. So the audit
 * carries a length and a truncated digest: enough to tell two attempts at the
 * same payload apart, not enough to be a credential dump.
 */
export function fingerprintBody(postData) {
  if (postData === null || postData === undefined) {
    return { bytes: 0, digest: null };
  }
  const text = Buffer.isBuffer(postData) ? postData.toString('utf8') : String(postData);
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    digest: createHash('sha256').update(text).digest('hex').slice(0, 16),
  };
}

/**
 * Normalize a Playwright Request (or a plain object in tests) into the shape
 * the policy decides on. Playwright's own method casing is already upper, but
 * the routing layer that hands us requests is not something we get to audit
 * from inside a plugin, so normalize rather than assume.
 *
 * Every accessor is wrapped. This is not defensive padding: an accessor that
 * throws inside a route handler leaves the request unresolved, which hangs the
 * page it belongs to. A URL that cannot be read becomes '' and is therefore
 * treated as a non-network URL, and a body that cannot be read becomes unknown
 * rather than empty, so neither can quietly downgrade a decision.
 */
function call(fn, receiver, ...args) {
  try {
    return Reflect.apply(fn, receiver, args);
  } catch {
    return undefined;
  }
}

/**
 * Read a value that may be exposed as an accessor or a plain property.
 *
 * Two traps here, both of which fail OPEN and so had to be closed.
 *
 * 1. If it is a function, that function is the only source of truth: falling
 *    back to the property would yield the function itself, and String(fn) is a
 *    61-character "body" that fingerprints perfectly happily.
 * 2. The receiver must be preserved. `const m = req.method; m()` runs with
 *    `this === undefined`, which throws inside Playwright's Request prototype,
 *    and an empty method string is not in the known-safe set... but an EMPTY
 *    URL is not an http URL either, so describeRequest returned
 *    { method: '', url: '' } and the gate allowed everything as
 *    "not-a-network-url". Caught by the real-engine tests, not by the fakes.
 */
function read(source, name) {
  const value = source?.[name];
  if (typeof value === 'function') return call(value, source);
  return value;
}

export function describeRequest(request) {
  const raw = request ?? {};
  const postData = read(raw, 'postData') ?? null;
  return {
    method: normalizeMethod(read(raw, 'method')),
    url: String(read(raw, 'url') ?? ''),
    postData,
    resourceType: read(raw, 'resourceType') ?? null,
    isNavigation: Boolean(read(raw, 'isNavigationRequest')),
    fingerprint: fingerprintBody(postData),
  };
}

/**
 * Does an approval the human already gave cover this request?
 *
 * A grant is { method, url, scope, fingerprint? }. Scope 'session' matches on
 * method + URL for the rest of the session, which is what "the human has
 * already approved this for this session" means. Scope 'once' additionally
 * requires the same body fingerprint, so a human who approved one specific
 * payload does not thereby approve every other payload to the same endpoint.
 *
 * Deliberately exact on the URL: no prefix matching, no "same path different
 * query", no "same path ignoring the method". A grant is a hole in the gate and
 * a hole should be as small as the human's decision was.
 */
export function grantCovers(grant, described) {
  if (!grant) return false;
  if (normalizeMethod(grant.method) !== described.method) return false;
  if (String(grant.url) !== described.url) return false;
  if (grant.scope === 'session') return true;
  const grantedDigest = grant.fingerprint?.digest ?? null;
  if (grantedDigest === null) return true;
  return grantedDigest === described.fingerprint.digest;
}

/**
 * THE DECISION. Total, pure, and synchronous.
 *
 * Returns { action: 'allow' | 'ask', reason, grant? }.
 *
 * 'ask' is not a decision to allow -- it is a decision to stop and put the
 * request in front of a human. Resolving 'ask' into allow/refuse is the
 * approval layer's job (./approval.js), not the policy's, so that the policy
 * has exactly one question to answer: is this inside the known-safe set, or has
 * a human already approved this exact thing?
 */
export function decide(described, { grants = [] } = {}) {
  if (!isNetworkUrl(described.url)) {
    return { action: 'allow', reason: REASONS.NOT_NETWORK };
  }
  if (isSafeMethod(described.method)) {
    return { action: 'allow', reason: REASONS.SAFE_METHOD };
  }
  for (const grant of grants) {
    if (grantCovers(grant, described)) {
      return { action: 'allow', reason: REASONS.APPROVED, grant };
    }
  }
  return { action: 'ask', reason: REASONS.UNAPPROVED };
}
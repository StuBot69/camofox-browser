/**
 * EGRESS GATE PLUGIN.
 *
 * The thin layer. This file does three things and no more: subscribe to the
 * lifecycle events, mount the routes a human needs to answer an approval, and
 * delegate. Every decision lives in ./lib/, which is this repo's convention --
 * route handlers delegate, lib modules hold the logic.
 *
 * WHAT IT DOES. On session:created it installs ONE request gate on the user's
 * BrowserContext. From that moment every request that page makes -- the first
 * navigation, later navigations, assets, popups, and anything a button's
 * onclick fires with fetch() -- is checked at the moment of egress, before the
 * bytes leave. GET/HEAD/OPTIONS pass silently. POST/PUT/PATCH/DELETE (and any
 * verb outside the known-safe set) never pass silently: already approved for
 * this session -> allow and record; otherwise raise the approval surface and
 * WAIT; unavailable, denied, timed out or errored -> REFUSE.
 *
 * NO SERVER.JS CHANGES. Everything here rides the existing plugin contract
 * (lib/plugins.js: register(app, ctx, config), ctx.events) and the existing
 * event bus, and session:created is emitted via emitAsync at server.js:1376 --
 * after sessions.set(key, created) and before the context can produce a page,
 * so no request can escape the gate.
 *
 * WHY CONTEXT.LEVEL AND NOT page.route(). Installing both means Playwright
 * decides which handler wins, by registration order, which is not a property
 * anyone can read off this code. One handler, one coverage statement. See
 * ./lib/gate.js for the full argument.
 */
import { createEgressGate } from './lib/gate.js';
import { createApprovalSurface } from './lib/approval.js';
import { createAuditLog } from './lib/audit.js';
import { REASONS } from './lib/policy.js';
import { SCOPES } from './lib/approval.js';

/**
 * The gate waits inside the click's own action budget. A page.route() handler
 * is awaited while withTabLock() still holds the tab, so an approval that
 * outlasts HANDLER_TIMEOUT_MS turns into a tab_timeout that destroys the tab
 * mid-decision. Leave headroom, and refuse rather than outlive the budget.
 */
const APPROVAL_HEADROOM_MS = 5000;

export async function register(app, ctx, pluginConfig = {}) {
  const { events, log, config, sessions, auth } = ctx;

  const enabled = pluginConfig.enabled !== false;
  if (!enabled) {
    log('info', 'egress gate disabled by plugin config', { plugin: 'egress-gate' });
    return;
  }

  const handlerTimeoutMs = Number(config?.handlerTimeoutMs) || 30000;
  const configuredTimeout = Number(pluginConfig.timeoutMs) || 0;
  const maxWait = Math.max(1000, handlerTimeoutMs - APPROVAL_HEADROOM_MS);
  const timeoutMs = configuredTimeout > 0 ? Math.min(configuredTimeout, maxWait) : maxWait;
  if (configuredTimeout > maxWait) {
    log('warn', 'egress gate approval timeout clamped below the action budget', {
      configured: configuredTimeout,
      clampedTo: timeoutMs,
      handlerTimeoutMs,
    });
  }

  const mode = pluginConfig.mode === 'passive' ? 'passive' : 'ask';
  const audit = createAuditLog({
    capacity: Number(pluginConfig.auditCapacity) || 1000,
  });
  const approval = createApprovalSurface({ timeoutMs, mode, log });

  /**
   * Recover the tabId for the audit by reverse lookup from the live session
   * map, so attribution does not need a second route handler competing for the
   * same request. Returns null when the page is not a managed tab (a popup
   * before it is registered, or a page created by some other path).
   */
  function resolveTabId({ userId, request }) {
    let page = null;
    try {
      page = request?.frame?.()?.page?.() ?? null;
    } catch {
      return { tabId: null };
    }
    if (!page) return { tabId: null };
    const session = sessions.get(ctx.normalizeUserId ? ctx.normalizeUserId(userId) : String(userId));
    if (!session?.tabGroups) return { tabId: null };
    for (const group of session.tabGroups.values()) {
      for (const [tabId, tabState] of group) {
        if (tabState?.page === page) return { tabId };
      }
    }
    return { tabId: null };
  }

  const gate = createEgressGate({ approval, audit, resolveTabId, log });

  // --- lifecycle ---------------------------------------------------------------
  // emitAsync: the server awaits this before the context can create a page, so
  // there is no window in which an ungated request can be issued.
  events.on('session:created', async ({ userId, context }) => {
    try {
      await gate.installOnContext(context, { userId, sessionKey: userId });
    } catch (err) {
      // A gate that failed to install is a gate that is not there. Say so loudly
      // rather than letting the session run ungated and quiet.
      log('error', 'egress gate FAILED to install on session context', {
        userId,
        error: err?.message,
      });
    }
  });

  // A tab that dies takes its pending approvals with it: nobody is going to
  // answer a question about a page that no longer exists, and a waiter left
  // hanging is a waiter holding a lock.
  events.on('tab:destroyed', ({ userId, tabId }) => {
    approval.refuseWhere(
      (r) => tabId != null && String(r.tabId) === String(tabId),
      REASONS.APPROVAL_DENIED,
    );
    approval.refuseWhere(
      (r) => userId != null && String(r.userId) === String(userId),
      REASONS.APPROVAL_DENIED,
    );
  });

  events.on('session:destroyed', ({ userId }) => {
    approval.forgetSession(userId);
    approval.refuseWhere(
      (r) => userId != null && String(r.userId) === String(userId),
      REASONS.APPROVAL_DENIED,
    );
  });

  // --- the human's side --------------------------------------------------------
  const middleware = auth();

  app.get('/egress-gate/audit', middleware, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const decision = req.query.decision === 'allowed' || req.query.decision === 'refused'
      ? req.query.decision
      : undefined;
    res.json({ entries: audit.list({ limit, decision }) });
  });

  app.get('/egress-gate/stats', middleware, (_req, res) => {
    res.json({ ...gate.stats, pending: approval.pendingCount(), audit: audit.counts(), mode, timeoutMs });
  });

  app.get('/egress-gate/approvals/pending', middleware, (_req, res) => {
    res.json({ pending: approval.listPending() });
  });

  app.get('/egress-gate/approvals/:id', middleware, (req, res) => {
    const found = approval.listPending().find((p) => p.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'no such pending approval' });
    res.json(found);
  });

  app.post('/egress-gate/approvals/:id', middleware, (req, res) => {
    const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : 'once';
    const settled = approval.settle(req.params.id, {
      approved: req.body?.approved === true,
      scope,
    });
    if (!settled) {
      // Unknown or already-answered id. 409 rather than a fake 200: a client
      // that retries must be able to tell "I approved it" from "nothing
      // happened", or it will believe a gate that never opened.
      return res.status(409).json({ error: 'no such pending approval, or it was already settled' });
    }
    res.json({ ok: true, approved: req.body?.approved === true, scope });
  });

  app.get('/egress-gate/grants', middleware, (req, res) => {
    const sessionKey = req.query.sessionKey || req.query.userId;
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey or userId required' });
    res.json({ sessionKey: String(sessionKey), grants: approval.listGrants(sessionKey) });
  });

  app.delete('/egress-gate/grants', middleware, (req, res) => {
    const sessionKey = req.query.sessionKey || req.query.userId;
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey or userId required' });
    approval.forgetSession(sessionKey);
    res.json({ ok: true });
  });

  log('info', 'egress gate registered', {
    mode,
    timeoutMs,
    headroomMs: APPROVAL_HEADROOM_MS,
    handlerTimeoutMs,
  });
}

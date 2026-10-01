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
import { createArmedState, SCOPE } from './lib/armed.js';
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

  /**
   * The armed assertion. It answers one question an operator can act on: is the
   * gate provably in front of this session's egress right now? It is not a
   * second layer -- it is the thing that refuses to let "the gate is installed"
   * pass for "the gate works".
   */
  const armed = createArmedState({
    gate,
    log,
    enabled,
    lookupSession: (userId) => sessions.get(ctx.normalizeUserId ? ctx.normalizeUserId(userId) : String(userId)),
    destroySession: async (userId, opts) => {
      try {
        return await ctx.destroySession(userId, opts);
      } catch {
        // A session already gone is the state we wanted. Saying "failed" here
        // would train the reader to ignore the field.
        return true;
      }
    },
    canaryTimeoutMs: Number(pluginConfig.canaryTimeoutMs) || 5000,
  });

  /**
   * A gate that proves itself for one session and not the next is worse than no
   * assertion, so a disarm anywhere turns the gauge red and takes the affected
   * session down. enforce() is idempotent per user.
   */
  let armedGauge = null;
  try {
    armedGauge = await ctx.createMetric('gauge', {
      name: 'camofox_egress_gate_armed',
      help: '1 when the egress gate is proven armed on every live session, 0 otherwise',
    });
  } catch {
    armedGauge = null;
  }

  function publishArmedMetric() {
    try {
      armedGauge?.set(armed.snapshot().armed ? 1 : 0);
    } catch {
      /* metrics are observability, never a control path */
    }
  }

  // --- lifecycle ---------------------------------------------------------------
  // emitAsync: the server awaits this before the context can create a page, so
  // there is no window in which an ungated request can be issued.
  events.on('session:created', async ({ userId, context }) => {
    try {
      const result = await armed.arm(context, { userId });
      publishArmedMetric();
      if (result.armed) return;

      /**
       * THIS is the fail-closed path, and the ordering matters. server.js
       * already did sessions.set(key, created) before emitting this event, so
       * a session that stays registered is a session that will serve pages
       * from an ungated context. Tear it down before it can.
       */
      log('error', 'egress gate is NOT armed; destroying the session', {
        userId,
        reason: result.reason ?? 'gate-disabled',
      });
      await destroyUnarmedSession(userId);
    } catch (err) {
      // arm() THROWS rather than returning armed:false for every way it can
      // fail to prove itself, so this catch is the normal failure path, not an
      // edge case. A gate that failed to prove itself is a gate that is not
      // there: say so loudly, and do not let the session run ungated at all.
      log('error', 'egress gate FAILED to arm on session context; destroying the session', {
        userId,
        reason: err?.reason ?? 'arm-failed',
        error: err?.message,
      });
      await destroyUnarmedSession(userId);
    }
  });

  async function destroyUnarmedSession(userId) {
    try {
      await ctx.destroySession(userId, { reason: 'egress_gate_not_armed' });
    } catch (err) {
      log('error', 'egress gate could not destroy an unarmed session', {
        userId,
        error: err?.message,
      });
    }
  }

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
    // Drop the watcher and its timers. A late timer firing for a session we
    // closed on purpose would raise an alarm about our own cleanup.
    armed.forget(userId);
    approval.refuseWhere(
      (r) => userId != null && String(r.userId) === String(userId),
      REASONS.APPROVAL_DENIED,
    );
    publishArmedMetric();
  });

  // The watchdog is the only thing that notices a route being removed while the
  // process keeps running. Started here rather than on browser:launched so the
  // assertion exists even if the browser is launched before this plugin
  // registers, and stopped on browser:closed so a stale interval cannot report
  // a disarm for a browser that is gone on purpose.
  armed.startWatchdog();

  // browser:closed is the one event that can invalidate every session at once.
  // Nothing is disarmed here -- the gates were fine -- but nothing is armed
  // either, and the gauge must say so rather than reading stale true.
  events.on('browser:closed', () => {
    armed.stopWatchdog();
    publishArmedMetric();
  });

  // --- the human's side --------------------------------------------------------
  const middleware = auth();

  /**
   * The assertion endpoint. /health-style: 200 when the gate is proven armed,
   * 503 when it is not, body always present so the reason survives a scrape.
   * Deliberately NOT folded into the global /health: that endpoint's contract
   * belongs to the whole server, and a policy decision changing a page's status
   * code is not something to do silently.
   *
   * @openapi
   * /egress-gate/armed:
   *   get:
   *     tags: [System]
   *     summary: Whether the egress gate is provably armed on every live session
   *     description: >
   *       Returns 200 when the gate is proven armed for every live session and
   *       503 otherwise. The response body is returned in both cases and always
   *       includes `scope`, which states what the gate does and does not cover
   *       (307/308 redirect-chain hops are detected, never prevented).
   *     responses:
   *       200:
   *         description: Gate proven armed on every live session.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 armed:
   *                   type: boolean
   *                 state:
   *                   type: string
   *       503:
   *         description: Gate not armed, or arming could not be proven.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 armed:
   *                   type: boolean
   */
  app.get('/egress-gate/armed', middleware, (_req, res) => {
    const snap = armed.snapshot();
    publishArmedMetric();
    res.status(snap.armed ? 200 : 503).json(snap);
  });

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
    scope: SCOPE.detectionOfRedirectChains,
  });
}

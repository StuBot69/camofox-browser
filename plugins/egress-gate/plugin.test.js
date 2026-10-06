/**
 * The plugin index. What a plugin is allowed to do is defined by the contract,
 * but what it MUST do to not break the server is also testable. This tests the
 * wiring (events + routes) with fakes, and the message the user sees on
 * registration.
 */
import { jest } from '@jest/globals';
import { register } from './index.js';

const noop = () => {};

function fakeApp() {
  const routes = {};
  return {
    routes,
    get(path, ...handlers) {
      routes[`GET ${path}`] = handlers;
    },
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers;
    },
    delete(path, ...handlers) {
      routes[`DELETE ${path}`] = handlers;
    },
  };
}

function fakeCtx(overrides = {}) {
  const events = {
    listeners: new Set(),
    on(event, fn) {
      events.listeners.add({ event, fn });
    },
    emitAsync: jest.fn(async () => {}),
  };
  const auth = () => (req, res, next) => next();
  return {
    events,
    log: jest.fn(),
    config: { handlerTimeoutMs: 30000 },
    auth,
    sessions: new Map(),
    normalizeUserId: (u) => String(u),
    ...overrides,
  };
}

function findHandler(app, methodPath) {
  const handlers = app.routes[methodPath];
  if (!handlers) throw new Error(`no handler for ${methodPath}`);
  return handlers[handlers.length - 1];
}

function resStub() {
  const body = {};
  return {
    body,
    status(code) {
      body.status = code;
      return this;
    },
    json(payload) {
      body.json = payload;
      return this;
    },
  };
}

describe('egress-gate plugin', () => {
  test('registers and logs on startup', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    expect(ctx.log).toHaveBeenCalledWith(
      'info',
      'egress gate registered',
      expect.objectContaining({ mode: 'ask', timeoutMs: expect.any(Number) }),
    );
    // Routes mounted
    expect(app.routes['GET /egress-gate/audit']).toBeDefined();
    expect(app.routes['GET /egress-gate/approvals/pending']).toBeDefined();
    expect(app.routes['POST /egress-gate/approvals/:id']).toBeDefined();
    expect(app.routes['GET /egress-gate/grants']).toBeDefined();
    expect(app.routes['DELETE /egress-gate/grants']).toBeDefined();
  });

  test('can be disabled by plugin config', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, { enabled: false });

    expect(ctx.log).toHaveBeenCalledWith('info', 'egress gate disabled by plugin config', {
      plugin: 'egress-gate',
    });
    expect(Object.keys(app.routes)).toHaveLength(0);
  });

  test('listens to lifecycle events', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const eventNames = [...ctx.events.listeners].map((l) => l.event).sort();
    expect(eventNames).toEqual([
      'browser:closed',
      'session:created',
      'session:destroyed',
      'tab:destroyed',
    ]);
  });

  test('a session the gate cannot arm is DESTROYED, not logged and left running', async () => {
    const app = fakeApp();
    const destroySession = jest.fn(async () => true);
    const ctx = fakeCtx({ destroySession });
    await register(app, ctx, {});

    const handler = [...ctx.events.listeners].find((l) => l.event === 'session:created').fn;
    const badContext = {}; // missing route
    await handler({ userId: 'u1', context: badContext });

    // The load-bearing assertion. server.js registers the session BEFORE
    // emitting this event, so logging an error and carrying on leaves a live
    // session with an ungated context serving pages.
    expect(destroySession).toHaveBeenCalledWith('u1', { reason: 'egress_gate_not_armed' });
    expect(ctx.log).toHaveBeenCalledWith(
      'error',
      'egress gate FAILED to arm on session context; destroying the session',
      expect.objectContaining({ userId: 'u1', error: expect.any(String) }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      'error',
      'egress gate DISARMED',
      expect.objectContaining({ armed: false, event: 'egress_gate_disarmed' }),
    );
  });

    test('installs the route, and a context the gate cannot prove is DESTROYED', async () => {
    const ctx2 = fakeCtx({ destroySession: jest.fn(async () => true) });
    // A short canary so the unprovable case resolves in test time rather than
    // sitting on the production budget.
    await register(fakeApp(), ctx2, { canaryTimeoutMs: 50 });
    const handler2 = [...ctx2.events.listeners].find((l) => l.event === 'session:created').fn;

    let installed = false;
    const good = {
      route: jest.fn(async () => {
        installed = true;
      }),
      routeWebSocket: jest.fn(async () => true),
      on: jest.fn(),
      // A page that never issues the canary request: the route installs fine,
      // but nothing proves the handler runs.
      newPage: async () => ({ goto: async () => null, close: async () => {} }),
      pages: () => [],
    };
    await handler2({ userId: 'u2', context: good });

    // The route really was installed -- and it still is not enough. install()
    // returning is not arming.
    expect(installed).toBe(true);
    expect(ctx2.destroySession).toHaveBeenCalledWith('u2', { reason: 'egress_gate_not_armed' });
  });

  test('clamps approval timeout to stay below action budget', async () => {
    const app = fakeApp();
    const ctx = fakeCtx({ config: { handlerTimeoutMs: 30000 } });
    await register(app, ctx, { timeoutMs: 60000, headroomMs: 5000 });

    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      'egress gate approval timeout clamped below the action budget',
      expect.objectContaining({ configured: 60000, clampedTo: 25000 }),
    );
  });

  test('GET /egress-gate/audit respects limit and decision filter', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const h = findHandler(app, 'GET /egress-gate/audit');
    const req1 = { query: { limit: '2000' } };
    const res1 = resStub();
    h(req1, res1);
    expect(res1.body.json.entries).toBeDefined();
    // limit clamped to 500
    expect(res1.body.json).toEqual({ entries: expect.any(Array) });

    const req2 = { query: { decision: 'allowed', limit: '1' } };
    const res2 = resStub();
    h(req2, res2);
    expect(res2.body.json.entries.length).toBeLessThanOrEqual(1);
  });

  test('POST /egress-gate/approvals/:id requires an actual pending id', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const h = findHandler(app, 'POST /egress-gate/approvals/:id');
    const req = { params: { id: 'nope' }, body: { approved: true } };
    const res = resStub();
    h(req, res);
    expect(res.body.status).toBe(409);
    expect(res.body.json).toEqual({ error: 'no such pending approval, or it was already settled' });
  });

  test('GET /egress-gate/grants requires sessionKey or userId', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const h = findHandler(app, 'GET /egress-gate/grants');
    const res = resStub();
    h({ query: {} }, res);
    expect(res.body.status).toBe(400);
    expect(res.body.json).toEqual({ error: 'sessionKey or userId required' });
  });

  test('DELETE /egress-gate/grants forgets a session', async () => {
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const hDel = findHandler(app, 'DELETE /egress-gate/grants');
    const res = resStub();
    hDel({ query: { userId: 'u1' } }, res);
    expect(res.body.json).toEqual({ ok: true });
  });

  test('GET /egress-gate/armed is 503 with the scope attached when nothing is proven', async () => {
    // With no sessions at all the gate has proven nothing, so the answer is no
    // -- fail closed -- and the body still says what "no" covers, because a
    // bare 503 without a reason is how an assertion gets waved through.
    const app = fakeApp();
    const ctx = fakeCtx();
    await register(app, ctx, {});

    const h = findHandler(app, 'GET /egress-gate/armed');
    const res = resStub();
    h({}, res);
    expect(res.body.status).toBe(503);
    expect(res.body.json.armed).toBe(false);
    expect(res.body.json.scope.preventionOfRedirectChains).toBe('unavailable-in-plugin');
    expect(res.body.json.egress.prevented).toBe(0);
  });
});
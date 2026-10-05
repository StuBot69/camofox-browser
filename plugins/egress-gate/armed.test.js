/**
 * The armed-state assertion, and the redirect hole it cannot close.
 *
 * THE ORGANISING RULE FOR THIS FILE: every test that claims the gate is armed
 * must first assert the gate is armed, using an instrument other than the one it
 * is testing. A test that reads armed.js's own snapshot and concludes the gate
 * works is a tautology; the tests below check that the canary's request actually
 * arrived, that the refusal actually kept the body off the server, and that
 * breaking the gate turns the suite red.
 *
 * The redirect tests are the most important ones here. They assert a bypass that
 * CANNOT be fixed in this plugin. That is deliberate: if someone later fixes it at
 * the browser layer, these tests fail, which is the correct outcome for a test
 * pinned to observed behaviour. A test suite that cannot go red when reality
 * changes is decoration.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { firefox } from 'playwright-core';
import {
  createArmedState,
  GateDisarmedError,
  STATES,
  CHECKS,
  DISARM_REASONS,
  EGRESS_ALERTS,
  SCOPE,
} from './lib/armed.js';
import { createEgressGate } from './lib/gate.js';
import { createApprovalSurface } from './lib/approval.js';
import { createAuditLog } from './lib/audit.js';
import { findCamoufoxBinary, describeCamoufoxEngine, startRecordingServer, waitFor } from './test-helpers.js';

// 5 Oct 2026: was `const BIN = findCamoufoxBinary(); const realEngine = BIN ? describe : describe.skip;`
// That form reported "no binary" for three unrelated situations and skipped on all
// three, so on Linux CI — where the browser IS downloaded and installed but at a
// path this repo's resolver did not know — the entire real-engine 307/308 suite
// vanished SILENTLY and the run reported green. describeCamoufoxEngine skips only
// when the browser genuinely was never fetched, and fails loudly otherwise.
const realEngine = describeCamoufoxEngine;

/** Silent by default: a passing test that logs is fine, a failing one must shout. */
function makeLog() {
  const lines = [];
  return {
    lines,
    log: (level, msg, fields) => lines.push({ level, msg, fields }),
  };
}

/**
 * A context stand-in that is just real enough for the armed machinery.
 *
 * The handler it hands back is invoked by the tests directly, so a "canary
 * passed" here genuinely means observe() fired -- which is the property under
 * test. Fakes that call observe() unconditionally would make every assertion
 * vacuous, so this fake REQUIRES the test to fire the route handler explicitly.
 */
function fakeContext({
  routeThrows = false,
  /** Whether the canary's page.goto reaches the route handler. THE key switch. */
  probeFiresHandler = false,
  /** URL the probe answers with; defaults to the canary's own. */
  probeUrl = null,
  /** Optional inner handler; default is a no-op that still counts as observed. */
  handler = async () => {},
  wsRouteThrows = false,
} = {}) {
  const listeners = new Map();
  const registered = [];
  const wsRegistered = [];
  const self = {
    _routes: [],
    pages: () => [],
    /**
     * runCanary() calls context.newPage() directly, so newPage must live on the
     * context itself. An earlier version of this file put it on an object
     * returned by pages(), which made the first two tests pass for the wrong
     * reason: the probe threw before it could reach the handler, so the canary
     * timed out regardless of whether routing worked at all. The probe answers
     * here directly, so "the canary failed" and "the fake was unusable" stop
     * being the same outcome.
     */
    async newPage() {
      return {
        goto: async (u) => {
          if (!probeFiresHandler) return;
          // probeUrl defaults to the canary's own URL, which is what a working
          // route produces. Setting it elsewhere models "the handler ran, for
          // something else" -- the near-miss a counting implementation accepts.
          await self.fire('GET', typeof probeUrl === 'function' ? probeUrl(u) : probeUrl ?? u);
        },
        close: async () => {},
      };
    },
    async route(pattern, fn) {
      if (routeThrows) throw new Error('route() rejected');
      registered.push(fn);
      // Guarded: a test that simulates playwright-core renaming _routes sets it
      // to undefined, and the fake must not throw where the real client would
      // have carried on. A fake that fails for the wrong reason turns a test
      // about "unavailable is not disarmed" into a test about an exception.
      if (Array.isArray(self._routes)) self._routes.push({ url: pattern, handler: fn });
    },
    async routeWebSocket(pattern, fn) {
      if (wsRouteThrows) throw new Error('routeWebSocket() rejected');
      // Kept SEPARATE from `registered`. An earlier version pushed both into one
      // list, so fire() handed the WebSocket handler an (route, request) pair it
      // could not use, it threw, and the guard counted a handler error -- which
      // disarmed a gate that was working. The failure was in the fake.
      wsRegistered.push(fn);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    off(event, fn) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    /** Simulate the browser issuing a request that the route layer will see. */
    async issue(method, url) {
      await Promise.all(
        (listeners.get('request') || []).map((fn) => fn({ method: () => method, url: () => url })),
      );
    },
    registered,
    wsRegistered,
    /**
     * Stop answering the canary's probe, modelling unroute(): the context is still
     * there, the probe still runs, but nothing observes it.
     */
    probeSilent() {
      self._routes.length = 0;
      registered.length = 0;
    },
    /**
     * Fire the installed route handler, the way a real request would.
     *
     * The request double must have the real shape: gate.handle() runs
     * describeRequest() on it, and a bare {} yields a request with no URL, so
     * observe() would be called without the canary token and the canary would
     * fail for a reason that has nothing to do with routing.
     */
    async fire(method, url) {
      const route = {
        continue: async () => {},
        abort: async () => {},
      };
      const request = {
        method: () => method,
        url: () => url,
        postData: () => null,
        resourceType: () => 'document',
        isNavigationRequest: () => true,
        frame: () => ({ page: () => null }),
      };
      await handler({ method, url });
      for (const fn of registered) await fn(route, request);
    },
    /** Fire a WebSocket handshake handler, the way the browser would. */
    async fireWebSocket(url) {
      const closed = [];
      const ws = {
        url: () => url,
        close: (opts) => closed.push(opts),
        connectToServer: () => connected.push(url),
      };
      const connected = [];
      for (const fn of wsRegistered) await fn(ws);
      return { closed, connected };
    },
  };
  return self;
}

/** Builds a gate + armed state over a fake context, wired like index.js does. */
function rig({ context, mode = 'ask', canaryTimeoutMs = 500, ungatedGraceMs = 20 } = {}) {
  const logger = makeLog();
  const approval = createApprovalSurface({ mode, timeoutMs: 200 });
  const audit = createAuditLog();
  const gate = createEgressGate({ approval, audit, log: logger.log });
  const torn = [];
  const armed = createArmedState({
    gate,
    log: logger.log,
    canaryTimeoutMs,
    ungatedGraceMs,
    lookupSession: (id) => (torn.includes(String(id)) ? undefined : { context }),
    destroySession: async (id) => {
      torn.push(String(id));
      return true;
    },
  });
  return { armed, gate, approval, audit, logger, torn, context };
}

/**
 * Grant the pending approval the way a human would, and return the grant that
 * now exists. Deliberately goes through the real approval surface: the point of
 * the redirect tests is that a grant correctly scoped to /r307 does not cover
 * /hop2, so a fake grant would test nothing.
 */
async function approvePending(approval, sessionKey = 's', userId = 'u') {
  const pendingPromise = approval.ask({ method: 'POST', url: 'http://127.0.0.1:1/r307', sessionKey, userId });
  await waitFor(() => approval.listPending().length > 0, { what: 'approval to be pending' });
  const [record] = approval.listPending();
  const settled = approval.settle(record.id, { approved: true, scope: 'session' });
  await Promise.all([settled, pendingPromise.catch(() => {})]);
  return approval.grantsFor(sessionKey);
}

describe('armed state: the canary is the only credit', () => {
  let rig1;
  beforeEach(() => {
    rig1 = null;
  });

  test('a handler that never runs leaves the gate PENDING, not ARMED', async () => {
    // The exact failure the whole file exists for: context.route() RESOLVES (the
    // fake's route() succeeds) but the handler is never invoked. An implementation
    // that credited route() returning would report armed here.
    const ctx = fakeContext({ probeFiresHandler: false });
    const { armed, logger } = rig({ context: ctx });

    await expect(armed.arm(ctx, { userId: 'u1' })).rejects.toBeInstanceOf(GateDisarmedError);

    const snap = armed.snapshot();
    expect(snap.armed).toBe(false);
    expect(snap.state).toBe(STATES.DISARMED);
    expect(logger.lines.some((l) => l.level === 'error' && l.fields?.event === 'egress_gate_disarmed')).toBe(true);
  });

  test('canary that never fires reports canary-timed-out, not armed', async () => {
    const ctx = fakeContext();
    const { armed } = rig({ context: ctx, canaryTimeoutMs: 60 });

    await expect(armed.arm(ctx, { userId: 'u2' })).rejects.toMatchObject({
      reason: DISARM_REASONS.CANARY_TIMED_OUT,
      code: 'egress_gate_disarmed',
    });
    expect(armed.snapshot().checks.canaryPassed).not.toBe(CHECKS.OK);
  });

  test('handler observed for a DIFFERENT request does not credit the canary', async () => {
    // The near-miss that a counting implementation gets wrong: the handler ran,
    // but for a different URL, so interception for THIS context is unproven.
    // The handler is observed (canarySawHandler) and the canary still fails,
    // which is what distinguishes this from 'the handler never ran'.
    const ctx = fakeContext({ probeFiresHandler: true, probeUrl: 'http://elsewhere.test/other' });
    const { armed } = rig({ context: ctx, canaryTimeoutMs: 120 });

    const err = await armed.arm(ctx, { userId: 'u3' }).catch((e) => e);
    expect(err).toBeInstanceOf(GateDisarmedError);
    expect(err.reason).toBe(DISARM_REASONS.CANARY_NOT_SEEN);
    expect(err.detail).toBeDefined();
    expect(armed.snapshot().armed).toBe(false);
  });

  test('an observed canary token IS credit', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx });

    const result = await armed.arm(ctx, { userId: 'u4' });
    expect(result.armed).toBe(true);
    expect(result.checks.canary).toBe(CHECKS.OK);
    expect(armed.snapshot().armed).toBe(true);
    expect(armed.snapshot().armedSessionCount).toBe(1);
  });

  test('install that throws is recorded as install-threw with the error text', async () => {
    const ctx = fakeContext({ routeThrows: true });
    const { armed } = rig({ context: ctx });
    await expect(armed.arm(ctx, { userId: 'u5' })).rejects.toMatchObject({
      reason: DISARM_REASONS.INSTALL_THREW,
      detail: { error: expect.stringContaining('route() rejected') },
    });
    expect(armed.snapshot().checks.installFailures).toBeGreaterThan(0);
  });

  test('handler throwing into the dispatcher is counted, not hung', async () => {
    // gate.handle() is written not to throw. This is the day that stops being
    // true: an exception escaping into Playwright's route dispatcher leaves the
    // request unresolved and hangs the page, which reads as "camofox is broken"
    // and is the fastest way to get a gate switched off.
    //
    // The throw comes from a stub gate's INNER handler, because the guard under
    // test is the one armed.js wraps around whatever installOnContext hands it.
    // The stub observes first and throws second, matching the real ordering:
    // observe() runs before any policy branch, so a request that breaks inside
    // the policy has already been counted as seen.
    const ctx = fakeContext();
    const aborted = [];
    let innerCalls = 0;
    const stubGate = {
      stats: {},
      setObserver(fn) {
        stubGate._obs = fn;
      },
      async installOnContext(context, { wrap }) {
        const handler = wrap(async () => {
          innerCalls += 1;
          throw new Error('policy exploded');
        });
        // The probe reaches the handler, which observes and then throws.
        context.newPage = async () => ({
          goto: async (u) => {
            stubGate._obs?.({ method: 'GET', url: u });
            await handler(
              { continue: async () => {}, abort: async () => aborted.push('abort') },
              {
                method: () => 'GET',
                url: () => u,
                postData: () => null,
                resourceType: () => 'document',
                isNavigationRequest: () => true,
                frame: () => ({ page: () => null }),
              },
            );
          },
          close: async () => {},
        });
        ctx.registered.push(handler);
        return handler;
      },
    };
    const logger = makeLog();
    const armed = createArmedState({
      gate: stubGate,
      log: logger.log,
      canaryTimeoutMs: 300,
      lookupSession: () => ({ context: ctx }),
      destroySession: async () => true,
    });

    // Armed first, because observe() ran before the throw -- then disarmed by the
    // error count. Asserted in that order deliberately: reporting `armed: true`
    // for a context whose handler is throwing is the exact bug class here.
    const res = await armed.arm(ctx, { userId: 'u6' });
    expect(res.armed).toBe(true);
    expect(innerCalls).toBeGreaterThan(0);
    // Resolved, not hung: the guard aborted instead of leaving the route open.
    expect(aborted.length).toBeGreaterThan(0);
    expect(armed.snapshot().handler.errors).toBeGreaterThan(0);
    expect(armed.snapshot().armed).toBe(false);
    expect(logger.lines.some((l) => l.fields?.reason === DISARM_REASONS.HANDLER_ERRORED)).toBe(true);
  });

  test('route removed from the private table is reported, and an unreadable table is not a disarm', async () => {
    // The readable case: our handler is in the table, so the structural read
    // corroborates the behavioural canary.
    const seen = fakeContext({ probeFiresHandler: true });
    const r1 = rig({ context: seen });
    const ok = await r1.armed.arm(seen, { userId: 'u7' });
    expect(ok.armed).toBe(true);
    expect(ok.checks.route).toBe(CHECKS.PRESENT);

    // The unreadable case: playwright-core renamed the private field. The
    // structural read must become 'unavailable' and the gate must STAY ARMED.
    // Failing everyone closed because a dependency renamed an underscore field
    // is not fail-closed, it is just broken.
    const blind = fakeContext({ probeFiresHandler: true });
    blind._routes = undefined;
    const r2 = rig({ context: blind });
    const res2 = await r2.armed.arm(blind, { userId: 'u8' });
    expect(res2.armed).toBe(true);
    expect(res2.checks.route).toBe(CHECKS.UNAVAILABLE);
    expect(r2.armed.snapshot().armed).toBe(true);
  });

  test('a route removed from the readable table is caught', async () => {
    // The complementary case: the field IS readable and our handler is gone.
    // The canary is what notices, because ctx.fire() no longer reaches anything
    // that observes -- exactly the state unroute() leaves behind.
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx });
    expect((await armed.arm(ctx, { userId: 'u8b' })).armed).toBe(true);
    expect(armed.snapshot().armed).toBe(true);

    ctx._routes = []; // unroute() behind our back
    ctx.registered.length = 0; // and the handler with it
    ctx.probeSilent(); // the probe now reaches nothing
    const again = await armed.arm(ctx, { userId: 'u8c' }).catch((e) => e);
    expect(again).toBeInstanceOf(GateDisarmedError);
    expect(again.reason).toBe(DISARM_REASONS.CANARY_TIMED_OUT);
  });

  test('watchdog staleness is a disarmed state, not an absence of one', async () => {
    // A watchdog that stops watching is a gate nobody is checking. The clock is
    // injected so this is deterministic rather than a sleep.
    let clock = 1_000_000;
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx });
    const withClock = createArmedState({
      gate: createEgressGate({
        approval: createApprovalSurface({ mode: 'ask', timeoutMs: 200 }),
        audit: createAuditLog(),
      }),
      now: () => clock,
      canaryTimeoutMs: 200,
      watchdogIntervalMs: 1000,
      lookupSession: () => ({ context: ctx }),
      destroySession: async () => true,
    });
    expect((await withClock.arm(ctx, { userId: 'wd1' })).armed).toBe(true);
    withClock.startWatchdog();
    expect(withClock.snapshot().watchdog.running).toBe(true);
    expect(withClock.snapshot().checks.watchdog).toBe(CHECKS.FRESH);

    // Three intervals with no tick. A single late tick is not evidence of
    // anything; three is a watchdog that has stopped.
    clock += 1000 * 3 + 1;
    expect(withClock.snapshot().checks.watchdog).toBe(CHECKS.STALE);
    expect(withClock.snapshot().armed).toBe(false);
    expect(withClock.snapshot().reason).toBe(DISARM_REASONS.WATCHDOG_STALLED);
    withClock.stopWatchdog();
    expect(armed).toBeDefined();
  });

  test('a dead context is found by the watchdog pass and torn down', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const torn = [];
    const logger = makeLog();
    const gate = createEgressGate({
      approval: createApprovalSurface({ mode: 'ask', timeoutMs: 200 }),
      audit: createAuditLog(),
      log: logger.log,
    });
    let alive = true;
    const armed = createArmedState({
      gate,
      log: logger.log,
      canaryTimeoutMs: 200,
      lookupSession: () => (alive ? { context: ctx } : undefined),
      destroySession: async (id) => {
        torn.push(String(id));
        return true;
      },
    });
    await armed.arm(ctx, { userId: 'dead1' });
    expect(armed.snapshot().armed).toBe(true);
    alive = false; // the server reaped the context
    const pass = await armed.check({ reason: 'test' });
    expect(pass.ok).toBe(false);
    expect(pass.findings.some((f) => f.check === 'session' && f.result === CHECKS.DEAD)).toBe(true);
    expect(armed.snapshot().armed).toBe(false);
    expect(logger.lines.some((l) => l.fields?.reason === DISARM_REASONS.CONTEXT_DEAD)).toBe(true);
    await armed.enforce();
    expect(torn).toContain('dead1');
  });

  test('enforce destroys the session rather than flagging it', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed, torn } = rig({ context: ctx });
    await armed.arm(ctx, { userId: 'u9' });
    await armed.enforce({ userId: 'u9' });
    expect(torn).toContain('u9');
    expect(armed.snapshot().sessionCount).toBe(0);
  });
});

describe('the scope line is honest', () => {
  test('SCOPE names redirect chains as excluded and undiagnosable in-plugin', () => {
    expect(SCOPE.excludes.join(' ')).toMatch(/redirect/i);
    expect(SCOPE.covers.join(' ')).toMatch(/WebSocket/i);
    expect(SCOPE.preventionOfRedirectChains).toBe('unavailable-in-plugin');
    expect(SCOPE.enforcedAt).toEqual(['context.route', 'context.routeWebSocket']);
  });

  // Added 5 Oct 2026. The test above asserts `toMatch(/redirect/i)`, which is a
  // substring check: it passes on ANY wording containing the word "redirect",
  // including the pre-2026-10-05 string that named ONLY 307/308 and so told an
  // operator that 301/302 were covered when a PUT/PATCH/DELETE on those codes
  // carries its body past the gate. Mutation-tested: reverting the string to
  // its old wording left this suite fully green.
  //
  // So this pins the specific claim that was wrong. It is still a string
  // assertion and cannot prove the ENGINE's behaviour -- that is what
  // armed.test.js's real-engine cross-product tests and probes/ are for. What
  // it does guarantee is that the published sentence cannot silently shrink
  // back to naming only the two status codes.
  test('SCOPE does not understate the redirect hole: it names 301/302 for non-POST methods', () => {
    const excludes = SCOPE.excludes.join(' ');

    // Must not be the old status-only claim.
    expect(excludes).not.toMatch(/follow-up hop of a 307\/308 redirect chain/);

    // Must name the codes that DO carry a body past the gate.
    expect(excludes).toMatch(/301/);
    expect(excludes).toMatch(/302/);
    expect(excludes).toMatch(/307\/308/);

    // Must say the set is method-qualified, not status-only.
    expect(excludes).toMatch(/PUT, PATCH or DELETE/);

    // 5 Oct 2026 — two further pins, each for a falsehood an auditor MEASURED in
    // the previous wording. Both are the same class of defect as the original:
    // a sentence in the published string that is confidently untrue.
    //
    // (a) "303 downgrades every method to GET" was false — HEAD is exempt
    //     (`status === 303 && !["GET","HEAD"].includes(method)`, fetch.js:292).
    //     Pin it so the exception cannot be quietly dropped back into a universal.
    expect(excludes).toMatch(/except HEAD/i);

    // (b) The string carried no engine qualifier, so it read as a claim about
    //     Playwright in general. The project's own rule refuses "always" because
    //     Playwright does not promise redirect coverage, so the version belongs in
    //     the PUBLISHED sentence, not only in a code comment nobody outside the
    //     repo reads. Pin the qualifier and the explicit unmeasured caveat.
    expect(excludes).toMatch(/Camoufox 152\.0\.4-beta\.31/);
    expect(excludes).toMatch(/Other engines are unmeasured/i);

    // Must stay honest about not preventing.
    expect(excludes).toMatch(/NOT prevented/);
  });

  test('the snapshot publishes scope, and never claims redirect prevention', () => {
    const { armed } = rig({ context: fakeContext() });
    const snap = armed.snapshot();
    expect(snap.scope).toBe(SCOPE);
    expect(snap.egress.prevented).toBe(0);
    expect(snap.egress).toHaveProperty('detected');
  });
});

describe('redirect-chain DETECTION (not prevention)', () => {
  test('a mutating request the gate never claimed is reported as ungated', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed, logger } = rig({ context: ctx, ungatedGraceMs: 10 });
    await armed.arm(ctx, { userId: 'rd1' });

    // The gate claims the first hop.
    await ctx.fire('POST', 'http://127.0.0.1:1/r307');
    await ctx.issue('POST', 'http://127.0.0.1:1/r307');

    // The second hop appears on the request event and NO handler runs for it.
    // This is the bypass, observed from outside the interception layer.
    await ctx.issue('POST', 'http://127.0.0.1:1/hop2');
    await waitFor(() => armed.snapshot().egress.detected > 0, { what: 'ungated egress alert' });

    const snap = armed.snapshot();
    expect(snap.egress.detected).toBe(1);
    expect(snap.egress.prevented).toBe(0);
    const alert = logger.lines.find((l) => l.fields?.event === 'egress_gate_ungated_request');
    expect(alert.fields.alert).toBe(EGRESS_ALERTS.UNGATED_MUTATING_REQUEST);
    expect(alert.fields.url).toContain('/hop2');
    expect(alert.fields.prevented).toBe(false);
    // Loud: an error-level log, and not masked as a disarm.
    expect(alert.level).toBe('error');
    expect(snap.state).toBe(STATES.ARMED);
  });

  test('a gated POST does not license the NEXT gated POST to the same URL', async () => {
    // The regression this guards is quiet and permanent. Claims are kept to
    // handle the case where the route handler runs before the browser delivers
    // its 'request' event. If a claim is never consumed and never expires, the
    // first POST to /charge suppresses every later POST to /charge for the life
    // of the context -- and a real bypass to that URL would be invisible from
    // then on. An alarm system that goes permanently quiet after first use is
    // worse than no alarm.
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx, ungatedGraceMs: 10 });
    await armed.arm(ctx, { userId: 'rd5' });

    // One gated POST: the claim is created and consumed.
    await ctx.fire('POST', 'http://127.0.0.1:1/charge');
    await ctx.issue('POST', 'http://127.0.0.1:1/charge');

    // The same URL again, this time with no handler behind it.
    await ctx.issue('POST', 'http://127.0.0.1:1/charge');
    await waitFor(() => armed.snapshot().egress.detected === 1, {
      what: 'the SECOND post to an already-gated url to be reported',
    });
    expect(armed.snapshot().egress.suppressed).toBeGreaterThanOrEqual(1);
  });

  test('a normally gated POST is never reported as ungated', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx, ungatedGraceMs: 10 });
    await armed.arm(ctx, { userId: 'rd2' });

    for (let i = 0; i < 5; i += 1) {
      await ctx.fire('POST', `http://127.0.0.1:1/charge${i}`);
      await ctx.issue('POST', `http://127.0.0.1:1/charge${i}`);
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(armed.snapshot().egress.detected).toBe(0);
    expect(armed.snapshot().egress.suppressed).toBeGreaterThanOrEqual(5);
  });

  test('safe methods are ignored', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx, ungatedGraceMs: 10 });
    await armed.arm(ctx, { userId: 'rd3' });
    await ctx.issue('GET', 'http://127.0.0.1:1/pixel.gif');
    await ctx.issue('HEAD', 'http://127.0.0.1:1/pixel.gif');
    await new Promise((r) => setTimeout(r, 60));
    expect(armed.snapshot().egress.detected).toBe(0);
  });

  test('non-network URLs are ignored', async () => {
    const ctx = fakeContext({ probeFiresHandler: true });
    const { armed } = rig({ context: ctx, ungatedGraceMs: 10 });
    await armed.arm(ctx, { userId: 'rd4' });
    await ctx.issue('POST', 'blob:http://127.0.0.1:1/abc');
    await new Promise((r) => setTimeout(r, 60));
    expect(armed.snapshot().egress.detected).toBe(0);
  });
});

// The tests below use the real engine. They exist because the redirect finding
// came from a probe, and the lesson of the MV3 badge is that probes lie. These
// assert against the actual server's received bytes.
realEngine('real engine: the bypass is real, and the gate says so', (BIN) => {
  let browser;
  let context;
  let server;
  const built = [];

  beforeEach(async () => {
    browser = await firefox.launch({ headless: true, executablePath: BIN });
    context = await browser.newContext();
    server = await startRecordingServer();
  });

  afterEach(async () => {
    for (const b of built.splice(0)) await b.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  });

  /** Arm a real context and return the state, mirroring index.js. */
  async function armReal({ mode = 'ask', timeoutMs = 300 } = {}) {
    const logger = makeLog();
    const approval = createApprovalSurface({ mode, timeoutMs });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit, log: logger.log });
    const armed = createArmedState({
      gate,
      log: logger.log,
      canaryTimeoutMs: 3000,
      ungatedGraceMs: 150,
      lookupSession: () => ({ context }),
      destroySession: async () => true,
    });
    const result = await armed.arm(context, { userId: 'u' });
    return { armed, approval, audit, gate, logger, result };
  }

  test('arming a real context is proven by the handler, not by route() returning', async () => {
    const { armed, result, logger } = await armReal();
    // ASSERT ARMED FIRST. Crediting the gate before this line is the failure the
    // MV3 extension made.
    expect(result.armed).toBe(true);
    expect(armed.snapshot().armed).toBe(true);
    expect(result.checks.canary).toBe(CHECKS.OK);
    // And the proof came from a real request through the real context.
    expect(armed.snapshot().canary.passed).toBe(1);
    expect(armed.snapshot().handler.invocations).toBeGreaterThan(0);
    expect(logger.lines.some((l) => l.fields?.event === 'egress_gate_armed')).toBe(true);
  });

  test('CONTROL: with no gate at all, the mutation reaches the server', async () => {
    // The test that makes every other test mean something. If the recording
    // server did not receive POSTs without the gate, then "no arrivals" under the
    // gate would be evidence of nothing.
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'load' });
    await page.evaluate(() => fetch('/charge', { method: 'POST', body: 'control=1' }));
    await waitFor(() => server.mutatingArrivals().length > 0, { what: 'control POST to arrive' });
    expect(server.mutatingArrivals().map((r) => r.path)).toContain('/charge');
    expect(server.mutatingArrivals()[0].body).toBe('control=1');
  });

  test('a refused POST keeps its body off the server', async () => {
    const { armed, result } = await armReal({ mode: 'ask', timeoutMs: 200 });
    expect(result.armed).toBe(true);
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'load' });
    await page.evaluate(() => fetch('/charge', { method: 'POST', body: 'card=should-not-land' }).catch(() => {}));
    await waitFor(() => armed.snapshot().handler.invocations >= 2, { what: 'gate to see the POST' });
    await new Promise((r) => setTimeout(r, 300));
    const landed = server.mutatingArrivals();
    expect(landed).toHaveLength(0);
  });

  test('an approved POST DOES land -- the gate is not just blocking everything', async () => {
    // Without this, a gate that aborts everything would pass every other test in
    // this file while being useless.
    const { armed, result, approval } = await armReal({ mode: 'ask', timeoutMs: 2000 });
    expect(result.armed).toBe(true);
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'load' });
    const approving = (async () => {
      await waitFor(() => approval.listPending().length > 0, { what: 'approval prompt' });
      const [rec] = approval.listPending();
      await approval.settle(rec.id, { approved: true, scope: 'once' });
    })();
    await page.evaluate(() => fetch('/charge', { method: 'POST', body: 'card=4111111111111111' }).catch(() => {}));
    await approving;
    await waitFor(() => server.mutatingArrivals().length > 0, { what: 'approved POST to arrive' });
    expect(server.mutatingArrivals()[0].body).toBe('card=4111111111111111');
  });

  test('BREAKING THE GATE turns the arming assertion red', async () => {
    // The mutation test, done to the real gate rather than to a fake.
    // context.unrouteAll() is what a third party (or a bug) would do to remove
    // our handler behind our back. The SAME gate instance is re-armed, so
    // installOnContext declines (the context is in its routed set) and the canary
    // is the only thing that can notice -- which is exactly the property under
    // test. A fresh gate would simply reinstall and prove nothing.
    const { armed, result } = await armReal();
    expect(result.armed).toBe(true);

    await context.unrouteAll();
    const outcome = await armed.arm(context, { userId: 'u2' }).catch((err) => err);
    expect(outcome).toBeInstanceOf(GateDisarmedError);
    expect(armed.snapshot().armed).toBe(false);
  });

  test('after the route is removed, a POST really does reach the server ungated', async () => {
    // Confirms the breakage is real rather than a bookkeeping artifact: with the
    // route gone, the mutation lands with no gate decision. The armed assertion
    // above is trustworthy BECAUSE this is what it is protecting against.
    const { armed, result } = await armReal();
    expect(result.armed).toBe(true);
    await context.unrouteAll();
    await armed.arm(context, { userId: 'u2' }).catch(() => {});
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'load' });
    await page.evaluate(() => fetch('/charge', { method: 'POST', body: 'ungated=1' }).catch(() => {}));
    await waitFor(() => server.mutatingArrivals().length > 0, { what: 'ungated POST to land' });
    expect(server.mutatingArrivals()[0].body).toBe('ungated=1');
    // And the redirect detector names it, because nothing claimed it.
    await waitFor(() => armed.snapshot().egress.detected > 0, { what: 'ungated egress alarm' });
  });

  test('WebSocket handshake never reaches the HTTP route handler, and IS gated by routeWebSocket', async () => {
    // The finding: GET /ws arrived at the server with zero route-handler
    // invocations. A silently allowed GET, not a refusal.
    //
    // Asserted on the SERVER side and on the gate's own counters, not on the
    // page's WebSocket.readyState. A handshake closed from the route handler never
    // reaches the browser as a clean close event -- measured, the page stays
    // pending until it times out -- so asserting on 'the page saw close:1008'
    // would be asserting on an incidental detail of an unestablished socket.
    const { createServer } = await import('node:http');
    const upgrades = [];
    const wsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset=utf-8><title>ws</title>');
    });
    wsServer.on('upgrade', (req, socket) => {
      upgrades.push(req.url);
      socket.destroy();
    });
    await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
    const wsUrl = `ws://127.0.0.1:${wsServer.address().port}/ws`;

    try {
      const { armed, result, gate, approval, audit } = await armReal({ mode: 'ask', timeoutMs: 400 });
      expect(result.armed).toBe(true);

      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${wsServer.address().port}/`, { waitUntil: 'load' });
      await page.evaluate(
        (u) =>
          new Promise((resolve) => {
            const ws = new WebSocket(u);
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('error');
            ws.onclose = () => resolve('close');
            setTimeout(() => resolve('timeout'), 2500);
          }),
        wsUrl,
      );

      // The gate decided, on the WebSocket transport, and refused.
      expect(gate.stats.wsRefused).toBeGreaterThan(0);
      expect(gate.stats.wsAllowed).toBe(0);
      const wsAudit = audit.list().filter((a) => a.transport === 'websocket');
      expect(wsAudit.length).toBeGreaterThan(0);
      expect(wsAudit[wsAudit.length - 1].decision).toBe('refused');
      expect(wsAudit[wsAudit.length - 1].url).toContain('/ws');
      // And nothing arrived: a refused handshake means the server never saw it.
      expect(upgrades).toHaveLength(0);
      expect(approval.listPending().length).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise((r) => wsServer.close(r));
    }
  });

  test('an approved WebSocket is still refused, because pass-through does not work here', async () => {
    // This test asserts an UNDESIRABLE outcome, deliberately. On Camoufox/Firefox
    // with playwright-core 1.59.1, routeWebSocket() intercepts so refusal works,
    // but connectToServer() resolves WITHOUT the server ever seeing the
    // handshake -- playwright's client swallows the failure. Verified against a
    // live server: baseline (no interception) opens; intercepted +
    // connectToServer() times out with zero upgrades received.
    //
    // So "allow" cannot mean "connect to the server" on this engine. It would mean
    // handing the page a socket it believes is connected and that has no server
    // behind it. The gate refuses instead, loudly, with a distinct reason --
    // because a refused socket is diagnosable and a phantom one is not.
    //
    // If this test starts failing because the engine gained real pass-through,
    // that is good news and the gate should be changed to allow. The assertion
    // that makes that visible: `upgrades` is empty AND the page never sees open.
    const { createServer } = await import('node:http');
    const upgrades = [];
    // Tracked so cleanup can finish. An upgraded socket is a LIVE connection, so
    // wsServer.close() waits forever on a socket nobody closed -- which is what
    // made this test hit jest's 60s timeout instead of failing an assertion.
    const openSockets = [];
    const wsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset=utf-8><title>ws</title>');
    });
    wsServer.on('upgrade', (req, socket) => {
      upgrades.push(req.url);
      openSockets.push(socket);
      socket.on('error', () => {});
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
    const port = wsServer.address().port;

    try {
      // The control, first: without interception this server does open a socket.
      // Asserted so the refusal above cannot be explained by a broken server.
      {
        const plain = await browser.newContext();
        const pp = await plain.newPage();
        await pp.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
        const baseline = await pp.evaluate(
          (u) =>
            new Promise((resolve) => {
              const ws = new WebSocket(u);
              ws.onopen = () => resolve('open');
              ws.onerror = () => resolve('error');
              setTimeout(() => resolve('timeout'), 2500);
            }),
          `ws://127.0.0.1:${port}/baseline`,
        );
        expect(baseline).toBe('open');
        expect(upgrades).toContain('/baseline');
        await plain.close();
      }

      const { result, gate, approval, logger } = await armReal({ mode: 'ask', timeoutMs: 3000 });
      expect(result.armed).toBe(true);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
      const approving = (async () => {
        await waitFor(() => approval.listPending().length > 0, { what: 'websocket approval prompt' });
        const [rec] = approval.listPending();
        await approval.settle(rec.id, { approved: true, scope: 'once' });
      })();
      const state = await page.evaluate(
        (u) =>
          new Promise((resolve) => {
            const ws = new WebSocket(u);
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('error');
            ws.onclose = () => resolve('close');
            setTimeout(() => resolve('timeout'), 3000);
          }),
        `ws://127.0.0.1:${port}/ws`,
      );
      await approving;

      // Approved, yet refused -- and it says so.
      expect(gate.stats.wsAllowed).toBeGreaterThan(0);
      expect(state).not.toBe('open');
      expect(upgrades).not.toContain('/ws');
      const warned = logger.lines.find(
        (l) => l.fields?.event === 'egress_gate_websocket_passthrough_unsupported',
      );
      expect(warned).toBeDefined();
      expect(warned.fields.approved).toBe(true);
      expect(SCOPE.websocketPassThrough).toBe('unsupported-on-this-engine');
    } finally {
      for (const s of openSockets) s.destroy();
      await new Promise((r) => wsServer.close(r));
    }
  });
});

realEngine('real engine: 307/308 redirect chain, detected not prevented', (BIN) => {
  let browser;
  let context;

  beforeEach(async () => {
    browser = await firefox.launch({ headless: true, executablePath: BIN });
    context = await browser.newContext();
  });
  afterEach(async () => {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  });

  /**
   * Server whose /r307 answers 307 to /hop2. Returns the arrived log. The
   * recording is the assertion surface: what the server received is the only
   * thing that cannot be argued with.
   */
  async function redirectServer() {
    const arrived = [];
    const srv = await startRecordingServer();
    const orig = srv.close;
    const { createServer } = await import('node:http');
    const srv2 = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        arrived.push({ method: req.method, path: req.url, body });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<!doctype html><meta charset=utf-8><button id="jsfetch" onclick="fetch(\'/r307\',{method:\'POST\',body:\'card=4111111111111111\'})">Pay</button>' +
              '<form method="post" action="/r307"><input name="card" value="4111111111111111"><button id="postform" type="submit">Pay by form</button></form>',
          );
        } else if (req.url === '/r307') {
          res.writeHead(307, { Location: '/hop2' });
          res.end();
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    await srv.close();
    return {
      arrived,
      url: `http://127.0.0.1:${srv2.address().port}/`,
      close: () => new Promise((r) => srv2.close(r)),
    };
  }

  test('the second hop carries the body and gets NO gate decision -- and the gate alarms', async () => {
    const srv = await redirectServer();
    const logger = makeLog();
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 200 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit, log: logger.log });
    const armed = createArmedState({
      gate,
      log: logger.log,
      canaryTimeoutMs: 3000,
      ungatedGraceMs: 200,
      lookupSession: () => ({ context }),
      destroySession: async () => true,
    });
    const result = await armed.arm(context, { userId: 'u' });
    expect(result.armed).toBe(true);

    const page = await context.newPage();
    await page.goto(srv.url, { waitUntil: 'load' });

    // Approve hop 1 the way a human would, then watch hop 2 leave unexamined.
    const approving = (async () => {
      await waitFor(() => approval.listPending().length > 0, { what: 'approval prompt' });
      const [rec] = approval.listPending();
      await approval.settle(rec.id, { approved: true, scope: 'session' });
    })();
    await page.click('#jsfetch').catch(() => {});
    await approving.catch(() => {});

    await waitFor(
      () => srv.arrived.some((r) => r.path === '/hop2' && r.method === 'POST'),
      { what: 'the second hop to leave the machine' },
    );

    // THE BYPASS, pinned. The audit shows a decision for /r307 and NONE for /hop2,
    // while the server received both with the card body intact.
    const decided = audit.list().map((a) => a.url.replace(srv.url, '/'));
    expect(decided).toContain('/r307');
    expect(decided).not.toContain('/hop2');
    expect(srv.arrived.find((r) => r.path === '/hop2').body).toBe('card=4111111111111111');

    // THE DETECTION. Loud, honest about not preventing it, and not misfiled as a
    // disarm -- the route is working; it is not the layer involved.
    await waitFor(() => armed.snapshot().egress.detected > 0, { what: 'ungated egress alarm' });
    const alert = logger.lines.find((l) => l.fields?.event === 'egress_gate_ungated_request');
    expect(alert.fields.url).toContain('/hop2');
    expect(alert.fields.prevented).toBe(false);
    expect(alert.fields.reason).toBe('redirect-chain-second-hop-below-route-layer');
    expect(armed.snapshot().egress.prevented).toBe(0);
    expect(armed.snapshot().scope.excludes.join(' ')).toMatch(/redirect/i);

    await srv.close();
  });

  test('navigating <form method=post> is affected the same way', async () => {
    const srv = await redirectServer();
    const logger = makeLog();
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 200 });
    const gate = createEgressGate({ approval, audit: createAuditLog(), log: logger.log });
    const armed = createArmedState({
      gate,
      log: logger.log,
      canaryTimeoutMs: 3000,
      ungatedGraceMs: 200,
      lookupSession: () => ({ context }),
      destroySession: async () => true,
    });
    expect((await armed.arm(context, { userId: 'u' })).armed).toBe(true);

    const page = await context.newPage();
    await page.goto(srv.url, { waitUntil: 'load' });
    const approving = (async () => {
      await waitFor(() => approval.listPending().length > 0, { what: 'approval prompt' });
      const [rec] = approval.listPending();
      await approval.settle(rec.id, { approved: true, scope: 'session' });
    })();
    await page.click('#postform').catch(() => {});
    await approving.catch(() => {});
    await waitFor(() => srv.arrived.some((r) => r.path === '/hop2' && r.method === 'POST'), {
      what: 'the form-driven second hop',
    });
    await waitFor(() => armed.snapshot().egress.detected > 0, { what: 'ungated egress alarm' });
    expect(armed.snapshot().egress.prevented).toBe(0);
    await srv.close();
  });

  test('301/302 downgrade POST to GET and are NOT affected', async () => {
    // The control that keeps the finding honest: the bypass is specific to
    // method-preserving redirects, not a general "redirects are broken".
    const arrived = [];
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        arrived.push({ method: req.method, path: req.url, body });
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><meta charset=utf-8><button id=go onclick="fetch('/r302',{method:'POST',body:'card=4111111111111111'})">go</button>`);
        } else if (req.url === '/r302') {
          res.writeHead(302, { Location: '/hop2' });
          res.end();
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;

    const logger = makeLog();
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 200 });
    const gate = createEgressGate({ approval, audit: createAuditLog(), log: logger.log });
    const armed = createArmedState({
      gate,
      log: logger.log,
      canaryTimeoutMs: 3000,
      ungatedGraceMs: 200,
      lookupSession: () => ({ context }),
      destroySession: async () => true,
    });
    expect((await armed.arm(context, { userId: 'u' })).armed).toBe(true);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const approving = (async () => {
      await waitFor(() => approval.listPending().length > 0, { what: 'approval prompt' });
      const [rec] = approval.listPending();
      await approval.settle(rec.id, { approved: true, scope: 'session' });
    })();
    await page.click('#go').catch(() => {});
    await approving.catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    // No POST body ever follows a 302, so there is nothing ungated to alarm on.
    const postHop = arrived.filter((r) => r.method === 'POST' && r.path === '/hop2');
    expect(postHop).toHaveLength(0);
    expect(armed.snapshot().egress.detected).toBe(0);

    await new Promise((r) => srv.close(r));
  });
});
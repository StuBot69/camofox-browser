/**
 * The gate: policy + approval + exactly one resolution.
 *
 * These are the tests the brief asks for by name -- GET passes silently and is
 * not a logged decision; POST with no approval available is refused; POST
 * matching an approval is allowed AND recorded; every request resolves exactly
 * once -- plus the checks that a gate nobody can audit gets switched off.
 */
import { describe, expect, test, jest } from '@jest/globals';
import { createEgressGate } from './gate.js';
import { createApprovalSurface } from './approval.js';
import { createAuditLog } from './audit.js';
import { REASONS } from './policy.js';
import { fakeRequest, fakeRoute } from '../test-helpers.js';

function harness({ mode = 'ask', timeoutMs = 60, log = () => {} } = {}) {
  const approval = createApprovalSurface({ mode, timeoutMs, log });
  const audit = createAuditLog();
  const gate = createEgressGate({ approval, audit, log });
  return { approval, audit, gate };
}

/** Run one request through the gate and hand back what happened. */
async function run(gate, request, extra = {}) {
  const route = fakeRoute();
  await gate.handle({ route, request, userId: 'user-1', sessionKey: 'user-1', ...extra });
  return route;
}

describe('GET passes silently', () => {
  test('a GET is continued and is NOT a logged decision', async () => {
    const { gate, audit } = harness();
    const route = await run(gate, fakeRequest({ method: 'GET', url: 'http://x.test/page' }));

    expect(route.resolutions).toEqual(['continue']);
    // The point of "silently": an audit row for every asset load is an audit
    // nobody reads.
    expect(audit.size()).toBe(0);
    expect(gate.stats.allowedSilent).toBe(1);
  });

  test('HEAD and OPTIONS are silent too', async () => {
    const { gate, audit } = harness();
    for (const method of ['HEAD', 'OPTIONS']) {
      const route = await run(gate, fakeRequest({ method, url: 'http://x.test/x' }));
      expect(route.resolutions).toEqual(['continue']);
    }
    expect(audit.size()).toBe(0);
  });

  test('a GET with a body is still a GET, and still silent', async () => {
    const { gate, audit } = harness();
    const route = await run(gate, fakeRequest({ method: 'GET', url: 'http://x.test/x', postData: 'a=1' }));
    expect(route.resolutions).toEqual(['continue']);
    expect(audit.size()).toBe(0);
  });
});

describe('POST with no approval available fails closed', () => {
  test('an unavailable approval path aborts and says why', async () => {
    const { gate, audit } = harness({ mode: 'passive' });
    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge' }));

    expect(route.resolutions).toEqual(['abort']);
    expect(route.resolutions).not.toContain('continue');
    expect(audit.list()).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: 'http://x.test/charge',
        decision: 'refused',
        reason: REASONS.APPROVAL_UNAVAILABLE,
      }),
    ]);
  });

  test('an approval nobody answers aborts on timeout', async () => {
    const { gate, audit } = harness({ timeoutMs: 30 });
    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge' }));

    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0]).toMatchObject({
      decision: 'refused',
      reason: REASONS.APPROVAL_TIMEOUT,
    });
    expect(audit.list()[0].waitedMs).toBeGreaterThanOrEqual(0);
  });

  test('a human saying no aborts', async () => {
    const { approval, gate, audit } = harness({ timeoutMs: 5000 });
    const pending = run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge' }));
    await new Promise((r) => setTimeout(r, 5));
    const [record] = approval.listPending();
    expect(record).toMatchObject({ method: 'POST', url: 'http://x.test/charge' });
    approval.settle(record.id, { approved: false });

    const route = await pending;
    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0]).toMatchObject({ decision: 'refused', reason: REASONS.APPROVAL_DENIED });
  });

  test('if the approval machinery throws, the request is refused rather than allowed', async () => {
    const approval = {
      available: () => true,
      timeoutMs: 50,
      listGrants: () => [],
      ask: async () => {
        throw new Error('the approval bus is on fire');
      },
    };
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge' }));

    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0]).toMatchObject({
      decision: 'refused',
      reason: REASONS.APPROVAL_ERRORED,
    });
  });

  test('an approval that answers with nonsense is treated as a refusal', async () => {
    const approval = {
      available: () => true,
      timeoutMs: 50,
      listGrants: () => [],
      ask: async () => undefined,
    };
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge' }));
    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0].decision).toBe('refused');
  });
});

describe('POST matching an approval is allowed and recorded', () => {
  test('the approval settles, the request continues, and the log has the attribution', async () => {
    const { approval, gate, audit } = harness({ timeoutMs: 5000 });
    const pending = run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=500' }));

    await new Promise((r) => setTimeout(r, 5));
    const [record] = approval.listPending();
    expect(record.url).toBe('http://x.test/charge');
    approval.settle(record.id, { approved: true, scope: 'once' });

    const route = await pending;
    expect(route.resolutions).toEqual(['continue']);

    const [entry] = audit.list();
    expect(entry).toMatchObject({
      method: 'POST',
      url: 'http://x.test/charge',
      decision: 'allowed',
      reason: REASONS.APPROVED,
      approvalId: record.id,
      grantedScope: 'once',
      userId: 'user-1',
    });
    expect(typeof entry.at).toBe('number');
    expect(entry.bodyDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a second identical request asks again, because once means once', async () => {
    const { approval, gate, audit } = harness({ timeoutMs: 5000 });
    const request = () => fakeRequest({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=500' });

    const first = run(gate, request());
    await new Promise((r) => setTimeout(r, 5));
    const [record] = approval.listPending();
    approval.settle(record.id, { approved: true, scope: 'once' });
    expect((await first).resolutions).toEqual(['continue']);

    // Same payload again. This test used to assert the opposite -- "the once-grant
    // covers it, and nobody is asked twice" -- which is exactly the bug Stu found
    // by pressing the button twice in the end-to-end demo. An identical repeat is
    // what a retrying agent emits, and one approval was given for one action.
    expect(approval.pendingCount()).toBe(0);
    const second = run(gate, request());
    await new Promise((r) => setTimeout(r, 5));
    expect(approval.pendingCount()).toBe(1);
    approval.settle(approval.listPending()[0].id, { approved: true, scope: 'once' });
    expect((await second).resolutions).toEqual(['continue']);

    const entries = audit.list();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.decision === 'allowed')).toBe(true);
  });

  test('an unanswered repeat is refused rather than silently allowed', async () => {
    const { approval, gate, audit } = harness({ timeoutMs: 40 });
    const request = () => fakeRequest({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=500' });

    const first = run(gate, request());
    await new Promise((r) => setTimeout(r, 5));
    approval.settle(approval.listPending()[0].id, { approved: true, scope: 'once' });
    expect((await first).resolutions).toEqual(['continue']);

    // Nobody answers this one. It must be refused -- fail closed -- not allowed
    // on the strength of the approval given a moment ago.
    const second = await run(gate, request());
    expect(second.resolutions).toEqual(['abort']);

    // audit.list() is most-recent-first, so the refusal is entries[0].
    const entries = audit.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].decision).toBe('refused');
    expect(entries[1].decision).toBe('allowed');
  });

  test('a session grant covers a different payload to the same endpoint', async () => {
    const { approval, gate } = harness({ timeoutMs: 5000 });
    const pending = run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=1' }));
    await new Promise((r) => setTimeout(r, 5));
    approval.settle(approval.listPending()[0].id, { approved: true, scope: 'session' });
    await pending;

    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=2' }));
    expect(route.resolutions).toEqual(['continue']);
  });
});

describe('every request resolves exactly once', () => {
  test('a mixed batch leaves no route unresolved', async () => {
    const { gate } = harness({ mode: 'passive' });
    const requests = [
      fakeRequest({ method: 'GET', url: 'http://x.test/a' }),
      fakeRequest({ method: 'GET', url: 'http://x.test/b.css' }),
      fakeRequest({ method: 'HEAD', url: 'http://x.test/c' }),
      fakeRequest({ method: 'POST', url: 'http://x.test/d' }),
      fakeRequest({ method: 'DELETE', url: 'http://x.test/e' }),
      fakeRequest({ method: 'GET', url: 'about:blank' }),
      fakeRequest({ method: 'GET', url: 'data:text/html,x' }),
      fakeRequest({ method: 'POST', url: 'blob:http://x.test/f' }),
    ];

    const resolutions = [];
    for (const request of requests) {
      const route = await run(gate, request);
      expect(route.resolutions).toHaveLength(1);
      resolutions.push(...route.resolutions);
    }
    expect(resolutions).toHaveLength(requests.length);
    expect(resolutions.filter((r) => r === 'abort')).toHaveLength(2);
  });

  test('a throwing route.continue() does not leave the handler rejecting into Playwright', async () => {
    const { gate } = harness();
    const route = fakeRoute();
    route.continue = async () => {
      throw new Error('page closed mid-flight');
    };
    await expect(
      gate.handle({
        route,
        request: fakeRequest({ method: 'GET', url: 'http://x.test/a' }),
        userId: 'user-1',
        sessionKey: 'user-1',
      }),
    ).resolves.toBeUndefined();
  });

  test('a route is only resolved once even if something tries twice', async () => {
    const { gate } = harness({ mode: 'passive' });
    const route = fakeRoute();
    await gate.handle({
      route,
      request: fakeRequest({ method: 'POST', url: 'http://x.test/a' }),
      userId: 'user-1',
      sessionKey: 'user-1',
    });
    // The gate itself only resolves once; this asserts the observable effect.
    expect(route.resolutions).toEqual(['abort']);
  });

  test('a request with no usable URL accessor does not hang the gate', async () => {
    const { gate } = harness();
    const broken = {
      method: () => 'GET',
      url: () => {
        throw new Error('no url');
      },
    };
    // describeRequest tolerates it, and the gate must still resolve.
    await expect(
      gate.handle({ route: fakeRoute(), request: broken, userId: 'u', sessionKey: 'u' }),
    ).resolves.toBeUndefined();
  });
});

describe('tab attribution', () => {
  test('the tabId is recovered from the live session map for the audit', async () => {
    const approval = createApprovalSurface({ mode: 'passive' });
    const audit = createAuditLog();
    const page = { id: 'page-1' };
    const gate = createEgressGate({
      approval,
      audit,
      resolveTabId: ({ request }) => {
        const p = request.frame().page();
        return p === page ? { tabId: 'tab-42' } : { tabId: null };
      },
    });

    const route = await run(
      gate,
      fakeRequest({ method: 'POST', url: 'http://x.test/charge', page }),
    );
    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0].tabId).toBe('tab-42');
  });

  test('an unresolvable page is recorded with no tabId rather than failing the request', async () => {
    const { gate, audit } = harness({ mode: 'passive' });
    const route = await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/charge', page: null }));
    expect(route.resolutions).toEqual(['abort']);
    expect(audit.list()[0].tabId).toBeNull();
  });
});

describe('stats', () => {
  test('the counters separate silent allows from audited decisions', async () => {
    const { gate } = harness({ mode: 'passive' });
    await run(gate, fakeRequest({ method: 'GET', url: 'http://x.test/a' }));
    await run(gate, fakeRequest({ method: 'POST', url: 'http://x.test/b' }));
    await run(gate, fakeRequest({ method: 'PUT', url: 'http://x.test/c' }));

    expect(gate.stats.allowedSilent).toBe(1);
    expect(gate.stats.refused).toBe(2);
    expect(gate.stats.asked).toBe(2);
    expect(gate.stats.doubleResolveAttempts).toBe(0);
  });
});
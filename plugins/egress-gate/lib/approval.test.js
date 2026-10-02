/**
 * The approval surface, and every way it can fail.
 *
 * The single most important assertion in this file is negative: there is no
 * input, no timing, and no error that makes this module return allowed without a
 * human having said yes. That is what "fail closed" means in practice, and it
 * is much easier to state as a test than to be confident about.
 */
import { describe, expect, test, jest } from '@jest/globals';
import { createApprovalSurface, DEFAULT_APPROVAL_TIMEOUT_MS, SCOPES } from './approval.js';
import { REASONS, fingerprintBody, decide } from './policy.js';

const REQ = {
  method: 'POST',
  url: 'http://x.test/billing',
  postData: 'card=4111111111111111&cvv=123',
  fingerprint: fingerprintBody('card=4111111111111111&cvv=123'),
  userId: 'user-1',
  sessionKey: 'user-1',
  tabId: 'tab-1',
};

const ids = () => {
  let n = 0;
  return () => `approval-${(n += 1)}`;
};

describe('asking a human', () => {
  test('an unanswered request times out and refuses', async () => {
    const surface = createApprovalSurface({ timeoutMs: 40, randomId: ids() });
    const outcome = await surface.ask(REQ);
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe(REASONS.APPROVAL_TIMEOUT);
  });

  test('a pending request is visible with everything a human needs to decide', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));

    const [record] = surface.listPending();
    expect(record).toMatchObject({
      id: 'approval-1',
      method: 'POST',
      url: 'http://x.test/billing',
      userId: 'user-1',
      tabId: 'tab-1',
    });
    expect(record.deadline).toBeGreaterThan(record.createdAt);
    // A human has to see the request in order to approve it, and the request
    // body is where the card number lives. It must not be on show.
    expect(JSON.stringify(record)).not.toContain('4111111111111111');
    expect(JSON.stringify(record)).not.toContain('cvv');
    expect(record.fingerprint.digest).toMatch(/^[0-9a-f]{16}$/);
    pending.catch(() => {});
  });

  test('approving allows, and records a grant', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));

    expect(surface.settle('approval-1', { approved: true, scope: 'once' })).toBe(true);
    const outcome = await pending;
    expect(outcome.allowed).toBe(true);
    expect(outcome.reason).toBe(REASONS.APPROVED);
    expect(outcome.grant).toMatchObject({ method: 'POST', url: 'http://x.test/billing', scope: 'once' });
    expect(surface.pendingCount()).toBe(0);
  });

  test('a human saying no refuses', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: false });
    expect(await pending).toEqual({ allowed: false, reason: REASONS.APPROVAL_DENIED });
  });

  test('anything other than a literal true is a refusal, not an approval', async () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
      const pending = surface.ask(REQ);
      await new Promise((r) => setTimeout(r, 5));
      surface.settle('approval-1', { approved: value });
      const outcome = await pending;
      expect(outcome.allowed).toBe(false);
    }
  });

  test('a double-approve cannot allow twice, and an unknown id settles nothing', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    expect(surface.settle('approval-1', { approved: true })).toBe(true);
    expect(surface.settle('approval-1', { approved: true })).toBe(false);
    expect(surface.settle('never-existed', { approved: true })).toBe(false);
    expect((await pending).allowed).toBe(true);
  });
});

describe('fail closed', () => {
  test('when the approval path is unavailable it refuses without waiting', async () => {
    const surface = createApprovalSurface({ mode: 'passive', randomId: ids() });
    expect(surface.available()).toBe(false);
    const t0 = Date.now();
    const outcome = await surface.ask(REQ);
    expect(outcome).toEqual({ allowed: false, reason: REASONS.UNAVAILABLE_DISABLED });
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('there is no sequence of calls that yields allowed without settle(approved:true)', async () => {
    const surface = createApprovalSurface({ timeoutMs: 25, randomId: ids() });
    // Let it time out, then try to settle the stale id.
    const first = await surface.ask(REQ);
    expect(first.allowed).toBe(false);
    expect(surface.settle('approval-1', { approved: true })).toBe(false);
    expect(surface.listGrants('user-1')).toEqual([]);
  });

  test('refuseWhere refuses matching waiters and leaves others alone', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const mine = surface.ask({ ...REQ, tabId: 'tab-dead' });
    const other = surface.ask({ ...REQ, tabId: 'tab-alive' });
    await new Promise((r) => setTimeout(r, 5));

    expect(surface.refuseWhere((r) => r.tabId === 'tab-dead')).toBe(1);
    expect((await mine).allowed).toBe(false);

    surface.settle('approval-2', { approved: true });
    expect((await other).allowed).toBe(true);
  });

  test('a per-call timeout override is honoured, so the gate can stay inside the action budget', async () => {
    const surface = createApprovalSurface({ timeoutMs: 60000, randomId: ids() });
    const t0 = Date.now();
    const outcome = await surface.ask(REQ, { timeoutMs: 30 });
    expect(outcome.reason).toBe(REASONS.APPROVAL_TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('a pending approval never holds the event loop open', async () => {
    const surface = createApprovalSurface({ timeoutMs: 600000, randomId: ids() });
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const pending = surface.ask(REQ);
    pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(during - before).toBeLessThanOrEqual(1);
    surface.settle('approval-1', { approved: false });
    await pending;
  });
});

describe('session grants', () => {
  test('a session grant survives for that session and is scoped to it', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: true, scope: 'session' });

    const outcome = await pending;
    expect(outcome.grant.scope).toBe('session');
    expect(surface.listGrants('user-1')).toHaveLength(1);
    expect(surface.listGrants('user-2')).toHaveLength(0);
  });

  test('forgetSession drops the grants, so the next request asks again', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: true, scope: 'session' });
    await pending;
    surface.forgetSession('user-1');
    expect(surface.listGrants('user-1')).toEqual([]);
  });

  test('a bogus scope from a client degrades to the tighter one', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: true, scope: 'everything-forever' });
    expect((await pending).grant.scope).toBe('once');
    expect(SCOPES).toEqual(['once', 'session']);
  });

  test('the default timeout is shorter than the server action budget it sits inside', () => {
    // server.js HANDLER_TIMEOUT_MS defaults to 30000 and TAB_LOCK_TIMEOUT_MS to
    // 35000; a form submit's page.click() does not settle while the gate waits
    // (measured), so a longer default would turn an approval into a dead tab.
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeLessThan(30000);
  });

  test('the log hook cannot change a decision', async () => {
    const log = jest.fn(() => {
      throw new Error('log is on fire');
    });
    const surface = createApprovalSurface({ timeoutMs: 30, randomId: ids(), log });
    const outcome = await surface.ask(REQ);
    expect(outcome.allowed).toBe(false);
    expect(log).toHaveBeenCalled();
    // The decision is the timeout, not the logger's exception.
  });
});

/**
 * 'Approve once' has to mean once.
 *
 * Found by running the end-to-end demo: approve an add-to-bag, click it again,
 * and the second POST reached the server with no second prompt. A 'once' grant is
 * stored keyed on method+url+body-digest and nothing consumed it, so any repeat
 * of the same payload matched it. That is not a hypothetical: an agent stuck in
 * a retry loop produces identical repeats forever, and the human approved one
 * action.
 */
describe('one-time grants are spent, not kept', () => {
  async function approveOnce(body = REQ.postData) {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const req = { ...REQ, postData: body, fingerprint: fingerprintBody(body) };
    const pending = surface.ask(req);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: true, scope: 'once' });
    const outcome = await pending;
    return { surface, grant: outcome.grant };
  }

  test('consuming a once-grant removes it, so the repeat asks again', async () => {
    const { surface, grant } = await approveOnce();
    expect(surface.listGrants(REQ.sessionKey)).toHaveLength(1);

    expect(surface.consume(REQ.sessionKey, grant)).toBe(true);
    expect(surface.listGrants(REQ.sessionKey)).toHaveLength(0);
  });

  test('the repeat of an identical payload is no longer covered', async () => {
    const { surface, grant } = await approveOnce();
    surface.consume(REQ.sessionKey, grant);

    // Same method, same URL, same body. It matched before.
    const repeat = { method: REQ.method, url: REQ.url,
                     fingerprint: fingerprintBody(REQ.postData) };
    expect(decide(repeat, { grants: surface.listGrants(REQ.sessionKey) }).action).toBe('ask');
  });

  test('a session grant survives being used -- that is what it is for', async () => {
    const surface = createApprovalSurface({ timeoutMs: 5000, randomId: ids() });
    const pending = surface.ask(REQ);
    await new Promise((r) => setTimeout(r, 5));
    surface.settle('approval-1', { approved: true, scope: 'session' });
    const { grant } = await pending;

    expect(surface.consume(REQ.sessionKey, grant)).toBe(false);
    expect(surface.listGrants(REQ.sessionKey)).toHaveLength(1);
  });

  test('consuming nothing, or twice, is harmless', async () => {
    const { surface, grant } = await approveOnce();
    expect(surface.consume(REQ.sessionKey, null)).toBe(false);
    expect(surface.consume(REQ.sessionKey, grant)).toBe(true);
    expect(surface.consume(REQ.sessionKey, grant)).toBe(false);
  });
});
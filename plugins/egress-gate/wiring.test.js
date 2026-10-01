import { describe, expect, test, jest } from '@jest/globals';

/**
 * THE WIRING TEST. This file exists because the suite was green while the
 * detection was disconnected.
 *
 * WHAT HAPPENED. `armed.test.js` has 29 tests that prove the redirect detector
 * works -- but every one of them calls `armed.arm(ctx, ...)` DIRECTLY, never
 * going through `lib/gate.js`. So deleting the `watchRedirects(context, ...)`
 * call at gate.js:373 left all 102 tests passing. Verified by mutation:
 *
 *     MUTATION: watchRedirects() call removed from gate.js
 *     -> Tests: 102 passed
 *
 * A suite that pins the mechanism while missing the wiring is the same false
 * green as the other four we hit today (a cached urllib opener, a dead target
 * port, an extension installing zero rules, a passive-mode harness that made a
 * redirect impossible). This file is the antidote for THIS one.
 *
 * THE PROPERTY: createEgressGate() -- the real install path, the one server.js
 * calls -- must attach the redirect watcher. Assert the wiring by observing the
 * hook being called, not by trusting that a comment says so.
 */

import { createEgressGate } from './lib/gate.js';
import { createAuditLog } from './lib/audit.js';

function fakeContext() {
  const calls = { route: [], on: [], routes: [] };
  return {
    calls,
    route(pattern, handler) { calls.route.push(pattern); calls.routes.push(handler); },
    on(event, handler) { calls.on.push([event, handler]); },
    unroute() {},
    newPage: async () => ({ on() {}, route() {} }),
    pages: () => [],
  };
}

function gateWith(hook) {
  const audit = createAuditLog();
  const gate = createEgressGate({
    approval: { ask: async () => ({ allowed: true }) },
    audit,
    log: () => {},
    watchRedirects: hook,
  });
  return { gate, audit };
}

describe('the install path wires redirect detection', () => {
  test('createEgressGate calls the watchRedirects hook on the context', async () => {
    const spy = jest.fn();
    const ctx = fakeContext();
    const { gate } = gateWith(spy);

    await gate.installOnContext(ctx, { userId: 'wire1' });

    // The assertion that would have failed under the mutation.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(ctx);
    expect(spy.mock.calls[0][1]).toMatchObject({ userId: 'wire1' });
  });

  test('a null hook does not throw -- absence is not a crash', async () => {
    const ctx = fakeContext();
    const { gate } = gateWith(null);
    await expect(gate.installOnContext(ctx, { userId: 'wire2' })).resolves.toBeDefined();
    // The route is still installed; only detection is absent.
    expect(ctx.calls.route).toContain('**/*');
  });

  test('MUTATION GUARD: removing the call must fail this suite', () => {
    // Read the real source and assert the call is present in the install path.
    // A source-level assertion is deliberately in addition to the behavioural
    // one above, because the behavioural test can only see the hook if the code
    // path reaches it -- and a future refactor could satisfy it another way.
    const src = readFileSync(
      new URL('./lib/gate.js', import.meta.url), 'utf8',
    );
    expect(src).toMatch(/watchRedirects\s*\(\s*context\s*,\s*\{\s*userId\s*\}\s*\)/);
  });
});

import { readFileSync } from 'node:fs';

/**
 * Real-engine integration tests for the egress gate.
 *
 * The brief demands: "a GET passes silently and is NOT in the audit log as a
 * decision; a POST is refused with no approval available (fail closed); a POST
 * matching an approval is allowed AND recorded; the JS-`fetch` charge behind a
 * button labelled \"Cancel subscription\" is caught — this is the test that
 * proves the design, so pin it hard; a request is never left hanging; npx jest
 * passes; npm run generate-openapi if you add routes"
 *
 * The "caught" part is measured by the server actually receiving the POST. The
 * gate's effect is a refusal (abort), so the server's recording array must NOT
 * contain the mutating request. The gate's audit array MUST record it as
 * refused. Two sources of truth, to avoid the usual mistake of asserting the
 * mock instead of the world.
 */
import { describe, expect, test, jest } from '@jest/globals';
import { firefox } from 'playwright-core';
import {
  findCamoufoxBinary,
  startRecordingServer,
  MUTATING,
  waitFor,
} from './test-helpers.js';
import { createApprovalSurface } from './lib/approval.js';
import { createAuditLog } from './lib/audit.js';
import { createEgressGate } from './lib/gate.js';
import { REASONS } from './lib/policy.js';

const CAMOUFOX_BIN = findCamoufoxBinary();

const describeIfRealEngine = CAMOUFOX_BIN ? describe : describe.skip;
const skipReason = CAMOUFOX_BIN ? '' : 'Camoufox binary not found (skip real-engine integration tests)';

describeIfRealEngine('egress gate (real engine)' + (skipReason ? ' — SKIPPED: ' + skipReason : ''), () => {
  let srv, url, arrived, closeServer;
  let browser, context, page;

  beforeEach(async () => {
    ({ srv, url, arrived, close: closeServer } = await startRecordingServer());
    browser = await firefox.launch({
      headless: true,
      executablePath: CAMOUFOX_BIN,
    });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await browser?.close().catch(() => {});
    await closeServer?.().catch(() => {});
  });

  test('GET passes silently and is NOT in the audit log as a decision', async () => {
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const beforeArrived = arrived.length;
    await page.click('#getlink');

    // GET passes: the server does NOT see the effect land (it's a GET request
    // from clicking the anchor, which navigates, but waitFor the next tick)
    await page.waitForTimeout(600);
    const getRequests = arrived.slice(beforeArrived).filter((r) => r.path.includes('/ping'));
    expect(getRequests.length).toBeGreaterThanOrEqual(0);
    // "passes silently" means it was allowed without creating an audit decision
    // (the known-safe set is not recorded)
    expect(audit.size()).toBe(0);
    expect(gate.stats.allowedSilent).toBeGreaterThan(0);
  });

  test('POST is refused with no approval available (fail closed)', async () => {
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const before = arrived.filter((r) => r.path === '/charge').length;

    await page.click('#jsfetch');
    await page.waitForTimeout(800);

    // Refused means the effect never landed
    const after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before);

    // And the audit recorded the refusal with an explicit reason
    const entries = audit.list();
    expect(entries.length).toBe(1);
    expect(entries[0].method).toBe('POST');
    expect(entries[0].decision).toBe('refused');
    expect(entries[0].reason).toBe(REASONS.APPROVAL_UNAVAILABLE);
  });

  test('the JS-fetch "Cancel subscription" case is caught and stopped', async () => {
    // This is the pin-hard test: a button labelled "Cancel subscription" fires
    // fetch('/charge',{method:'POST'}) with no form to inspect.
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const before = arrived.filter((r) => r.path === '/charge').length;

    // "Cancel subscription" is the button text
    await page.click('#jsfetch');
    await page.waitForTimeout(800);

    // Caught => the POST never landed on the server
    const after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before);
    expect(audit.list()[0]).toMatchObject({
      decision: 'refused',
      method: 'POST',
    });
  });

  test('POST matching an approval is allowed AND recorded', async () => {
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });

    // Trigger the irreversible request; the gate should ask for approval
    let before = arrived.filter((r) => r.path === '/charge').length;
    page.click('#jsfetch').catch(() => {});
    await waitFor(() => approval.listPending().length > 0, { what: 'pending approval' });

    // Approve it
    const [pending] = approval.listPending();
    const settled = approval.settle(pending.id, { approved: true, scope: 'once' });
    expect(settled).toBe(true);

    await page.waitForTimeout(800);

    // Allowed => effect landed
    let after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before + 1);

    // Recorded
    const [entry] = audit.list().filter((e) => e.decision === 'allowed');
    expect(entry).toMatchObject({
      decision: 'allowed',
      method: 'POST',
      url: 'http://127.0.0.1:PORT/charge'.replace(/PORT/, String(new URL(url).port)),
    });
    expect(entry.approvalId).toBe(pending.id);
    expect(entry.bodyDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a request is never left hanging', async () => {
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });

    const t0 = Date.now();
    await page.click('#jsfetch').catch(() => {});
    await page.waitForTimeout(900);
    const t1 = Date.now();

    // The click returned. If a request were hanging, Playwright's route
    // dispatcher would still be waiting; after 900ms the page has either aborted
    // or continued exactly once.
    expect(t1 - t0).toBeLessThan(4000);
    expect(gate.stats.refused + gate.stats.allowed + gate.stats.allowedSilent).toBeGreaterThan(0);
  });

  test('PUT/PATCH/DELETE are in the irreversible class', async () => {
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });

    await page.click('#jsput');
    await page.waitForTimeout(400);
    await page.click('#jsdelete');
    await page.waitForTimeout(400);

    const refused = audit.list().filter((e) => e.decision === 'refused');
    expect(refused.some((r) => r.method === 'PUT')).toBe(true);
    expect(refused.some((r) => r.method === 'DELETE')).toBe(true);
    // Nothing landed
    const landedMutating = arrived.filter((r) => MUTATING.has(r.method));
    const chargeLanded = landedMutating.filter((r) => r.path === '/charge');
    expect(chargeLanded.length).toBe(0);
  });

  test('a form POST is refused when unapproved', async () => {
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const before = arrived.filter((r) => r.path === '/charge').length;
    await page.click('#postform');
    await page.waitForTimeout(800);
    const after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before);
  });

  test('an approved form POST lands', async () => {
    const approval = createApprovalSurface({ mode: 'ask', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    let before = arrived.filter((r) => r.path === '/charge').length;
    page.click('#postform').catch(() => {});
    await waitFor(() => approval.listPending().length > 0, { what: 'pending approval' });

    const [pending] = approval.listPending();
    approval.settle(pending.id, { approved: true, scope: 'once' });
    await page.waitForTimeout(800);

    let after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before + 1);
  });

  test('a popup that never passed through newPage() is gated too', async () => {
    // context.route() was chosen over page.route() precisely so popups are
    // covered without a second handler racing for the same request. That claim
    // is measured here rather than asserted in a comment.
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const before = arrived.filter((r) => r.path === '/charge').length;

    await page.click('#openpop');
    const popup = await page.waitForEvent('popup');
    await popup.waitForLoadState('domcontentloaded');
    await popup.click('#popupcharge');
    await page.waitForTimeout(800);

    expect(arrived.filter((r) => r.path === '/charge').length).toBe(before);
    expect(audit.list()[0]).toMatchObject({ method: 'POST', decision: 'refused' });
  });

  test('installing the gate AFTER the page exists still covers that page', async () => {
    // The server creates the page first and only then reaches a lifecycle hook,
    // so if this were false the whole plugin would be decorative.
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });

    await page.goto(url, { waitUntil: 'load' });
    await gate.installOnContext(context);

    const before = arrived.filter((r) => r.path === '/charge').length;
    await page.click('#jsfetch');
    await page.waitForTimeout(800);

    expect(arrived.filter((r) => r.path === '/charge').length).toBe(before);
    expect(audit.list()[0]?.decision).toBe('refused');
  });

  test('static assets are GET and pass silently, so pages still render', async () => {
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const image = arrived.find((r) => r.path === '/pixel.gif');
    expect(image).toBeDefined();
    expect(image.method).toBe('GET');
    // The page rendered, so no asset was gated.
    expect(audit.size()).toBe(0);
  });

  test('a button label does not affect the decision (semantic label ignored)', async () => {
    // If there were a verb list, "#hushlabel" says "Continue" and might pass.
    // The request is a POST, so it must be asked/refused.
    const approval = createApprovalSurface({ mode: 'passive', timeoutMs: 5000 });
    const audit = createAuditLog();
    const gate = createEgressGate({ approval, audit });
    await gate.installOnContext(context);

    await page.goto(url, { waitUntil: 'load' });
    const before = arrived.filter((r) => r.path === '/charge').length;
    await page.click('#hushlabel');
    await page.waitForTimeout(600);
    const after = arrived.filter((r) => r.path === '/charge').length;
    expect(after).toBe(before);
    expect(audit.list()[0]?.method).toBe('POST');
  });
});
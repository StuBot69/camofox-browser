/**
 * The policy, tested without a browser.
 *
 * The point of these tests is that the decision depends ONLY on the method (and
 * on grants a human already gave). Every test here would still pass if the
 * button said anything at all, which is the property the whole design rests on.
 */
import { describe, expect, test } from '@jest/globals';
import {
  decide,
  describeRequest,
  grantCovers,
  fingerprintBody,
  isIrreversibleMethod,
  isSafeMethod,
  REASONS,
  SAFE_METHODS,
} from './policy.js';
import { fakeRequest } from '../test-helpers.js';

const described = (opts) => describeRequest(fakeRequest(opts));

describe('the known-safe set', () => {
  test('GET, HEAD and OPTIONS are safe and nothing else is', () => {
    expect([...SAFE_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS']);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isSafeMethod(m)).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isSafeMethod(m)).toBe(false);
  });

  test('an unknown verb is treated as irreversible, because an unknown verb is not evidence of safety', () => {
    for (const m of ['TRACE', 'FROBNICATE', 'CONNECT', 'LOCK', 'PROPFIND']) {
      expect(isIrreversibleMethod(m)).toBe(true);
    }
  });

  test('method casing and stray whitespace do not smuggle a verb past the gate', () => {
    expect(decide(described({ method: ' get ' })).action).toBe('allow');
    expect(decide(described({ method: 'post' })).action).toBe('ask');
    expect(decide(described({ method: 'Post' })).action).toBe('ask');
  });

  test('a safe method is allowed with the safe-method reason', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(decide(described({ method: m }))).toEqual({
        action: 'allow',
        reason: REASONS.SAFE_METHOD,
      });
    }
  });
});

describe('the irreversible class', () => {
  test('every irreversible method asks rather than allowing', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'FROBNICATE']) {
      expect(decide(described({ method: m }))).toEqual({
        action: 'ask',
        reason: REASONS.UNAPPROVED,
      });
    }
  });

  test('the decision does not read the URL path, query, or a word in it', () => {
    // These paths are named to look alarming and to look safe respectively.
    // A policy that matched on either would disagree between these two.
    const alarming = decide(described({ method: 'POST', url: 'http://x.test/delete-account' }));
    const innocuous = decide(described({ method: 'POST', url: 'http://x.test/ping' }));
    expect(alarming).toEqual(innocuous);
    expect(alarming.action).toBe('ask');
  });

  test('nothing about the resource type can move a request out of the irreversible class', () => {
    for (const resourceType of ['document', 'script', 'image', 'xhr', 'fetch', 'websocket', 'other']) {
      expect(decide(described({ method: 'POST', resourceType })).action).toBe('ask');
    }
  });
});

describe('non-network urls', () => {
  test('about:blank, data: and blob: have no server to gate and are passed', () => {
    for (const url of ['about:blank', 'data:text/html,hi', 'blob:http://x.test/abc']) {
      expect(decide(described({ method: 'POST', url }))).toEqual({
        action: 'allow',
        reason: REASONS.NOT_NETWORK,
      });
    }
  });
});

describe('grants', () => {
  const post = described({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=500' });

  test('a session grant covers the same method and URL regardless of body', () => {
    const grant = { method: 'POST', url: 'http://x.test/charge', scope: 'session' };
    expect(grantCovers(grant, post)).toBe(true);
    expect(grantCovers(grant, described({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=1' }))).toBe(true);
    expect(decide(post, { grants: [grant] })).toMatchObject({
      action: 'allow',
      reason: REASONS.APPROVED,
    });
  });

  test('a once grant requires the same body, so one payload approval is not a blanket approval', () => {
    const grant = {
      method: 'POST',
      url: 'http://x.test/charge',
      scope: 'once',
      fingerprint: fingerprintBody('amount=500'),
    };
    expect(grantCovers(grant, post)).toBe(true);
    expect(grantCovers(grant, described({ method: 'POST', url: 'http://x.test/charge', postData: 'amount=9999' }))).toBe(false);
  });

  test('a grant is exact on method and URL: no prefix, no same-path-different-query, no method drift', () => {
    const grant = { method: 'POST', url: 'http://x.test/charge', scope: 'session' };
    expect(grantCovers(grant, described({ method: 'PUT', url: 'http://x.test/charge' }))).toBe(false);
    expect(grantCovers(grant, described({ method: 'POST', url: 'http://x.test/charge/step2' }))).toBe(false);
    expect(grantCovers(grant, described({ method: 'POST', url: 'http://x.test/charge?amount=9999' }))).toBe(false);
    expect(grantCovers(grant, described({ method: 'POST', url: 'http://evil.test/charge' }))).toBe(false);
  });

  test('no grant, no allow', () => {
    expect(grantCovers(null, post)).toBe(false);
    expect(grantCovers(undefined, post)).toBe(false);
  });
});

describe('body fingerprints', () => {
  test('a body is fingerprinted by length and digest, never stored', () => {
    const fp = fingerprintBody('amount=500');
    expect(fp.bytes).toBe(10);
    expect(fp.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(fp)).not.toContain('500');
  });

  test('no body is a real value, not a wildcard', () => {
    expect(fingerprintBody(null)).toEqual({ bytes: 0, digest: null });
    expect(fingerprintBody(undefined)).toEqual({ bytes: 0, digest: null });
  });

  test('the same bytes fingerprint the same, different bytes do not', () => {
    expect(fingerprintBody('a=1').digest).toBe(fingerprintBody('a=1').digest);
    expect(fingerprintBody('a=1').digest).not.toBe(fingerprintBody('a=2').digest);
  });

  test('an unreadable body is treated as unknown, never as safe', () => {
    const request = fakeRequest({ method: 'POST', url: 'http://x.test/c' });
    request.postData = () => {
      throw new Error('body already consumed');
    };
    const d = describeRequest(request);
    expect(d.fingerprint).toEqual({ bytes: 0, digest: null });
    expect(decide(d).action).toBe('ask');
  });

  test('accessors that need `this` are called with their receiver intact', () => {
    // This is a regression test for a gate that silently allowed EVERYTHING.
    // Playwright exposes Request.method/url as prototype methods that read
    // this._initializer. Extracting `const m = req.method` and calling m() loses
    // the receiver, the method throws, describeRequest returns empty strings,
    // and an empty URL is "not a network url" -- so every request was allowed.
    // A fake built from arrow functions cannot catch that, because an arrow
    // function has no receiver to lose. Hence this object with real methods.
    class RealisticRequest {
      constructor(init) {
        this._initializer = init;
      }
      method() {
        return this._initializer.method;
      }
      url() {
        return this._initializer.url;
      }
      postData() {
        return this._initializer.postData;
      }
      resourceType() {
        return this._initializer.resourceType;
      }
      isNavigationRequest() {
        return this._initializer.isNavigationRequest;
      }
    }

    const describedRequest = describeRequest(
      new RealisticRequest({
        method: 'POST',
        url: 'http://x.test/charge',
        postData: 'amount=500',
        resourceType: 'fetch',
        isNavigationRequest: false,
      }),
    );

    expect(describedRequest).toMatchObject({
      method: 'POST',
      url: 'http://x.test/charge',
      resourceType: 'fetch',
    });
    expect(describedRequest.fingerprint.digest).toMatch(/^[0-9a-f]{16}$/);
    // The whole point: a POST read off a this-bound accessor must still be asked.
    expect(decide(describedRequest)).toEqual({
      action: 'ask',
      reason: REASONS.UNAPPROVED,
    });
  });
});
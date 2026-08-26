import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  base64UrlEncode,
  challengeFor,
  createVerifier,
  googleAuthorizeUrl,
  googleRedirectUri,
  randomState,
  rememberHandshake,
  takeHandshake,
} from './pkce';

describe('base64UrlEncode', () => {
  it('uses the URL-safe alphabet and drops the padding', () => {
    // Standard base64 of these bytes is "+/8=", which would need escaping both in
    // a query string and in a JSON body.
    expect(base64UrlEncode(new Uint8Array([251, 255, 255]))).toBe('-___');
    expect(base64UrlEncode(new Uint8Array([0]))).toBe('AA');
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
  });

  it('handles a buffer too large to spread into an argument list', () => {
    // `String.fromCharCode(...bytes)` throws on a large array; the loop does not.
    const large = new Uint8Array(200_000).fill(65);
    expect(() => base64UrlEncode(large)).not.toThrow();
    expect(base64UrlEncode(large)).not.toContain('=');
  });
});

describe('challengeFor', () => {
  /**
   * The published RFC 7636 appendix B test vector. If this ever fails the
   * challenge no longer matches what Google computes, and every Google sign-in
   * fails with an opaque `invalid_grant`.
   */
  it('matches the RFC 7636 test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic for one verifier and different across verifiers', async () => {
    const verifier = createVerifier();
    expect(await challengeFor(verifier)).toBe(await challengeFor(verifier));
    expect(await challengeFor(verifier)).not.toBe(await challengeFor(createVerifier()));
  });

  it('never emits the verifier itself', async () => {
    // Which is what the `plain` method RFC 7636 also permits would do — and it
    // defeats the whole mechanism, so it is deliberately not offered.
    const verifier = createVerifier();
    expect(await challengeFor(verifier)).not.toBe(verifier);
  });
});

describe('createVerifier and randomState', () => {
  it('produces a verifier inside the RFC length range', () => {
    const verifier = createVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces only unreserved characters', () => {
    // RFC 7636 restricts the verifier to [A-Za-z0-9-._~]; anything else would be
    // escaped in transit and no longer match.
    expect(createVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(randomState()).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createVerifier()));
    expect(seen.size).toBe(50);
  });
});

/**
 * This suite runs in the `node` environment (see vitest.config.ts — the point is
 * that these are pure functions, not components). `sessionStorage` therefore does
 * not exist, so it is stubbed rather than pulling jsdom in for four tests. The
 * code under test uses only get/set/remove, which this covers exactly.
 */
function installSessionStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
}

describe('the pending handshake', () => {
  beforeEach(() => {
    installSessionStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips what it stored', () => {
    rememberHandshake({ verifier: 'v', state: 's', returnTo: '/projects' });
    expect(takeHandshake()).toEqual({ verifier: 'v', state: 's', returnTo: '/projects' });
  });

  /**
   * Cleared on read, which is what makes a callback single-use: replaying the URL
   * finds nothing and is refused rather than being exchanged again.
   */
  it('can only be taken once', () => {
    rememberHandshake({ verifier: 'v', state: 's', returnTo: null });
    expect(takeHandshake()).not.toBeNull();
    expect(takeHandshake()).toBeNull();
  });

  it('returns null when nothing was stored', () => {
    // A callback arriving in a tab that never started a sign-in.
    expect(takeHandshake()).toBeNull();
  });

  it('does not leave a stale returnTo behind', () => {
    rememberHandshake({ verifier: 'v1', state: 's1', returnTo: '/settings' });
    takeHandshake();
    rememberHandshake({ verifier: 'v2', state: 's2', returnTo: null });
    // Otherwise the second sign-in would land on the first one's destination.
    expect(takeHandshake()?.returnTo).toBeNull();
  });
});

describe('googleAuthorizeUrl', () => {
  const input = {
    clientId: 'client-123.apps.googleusercontent.com',
    redirectUri: 'https://app.example.com/auth/callback/google',
    state: 'state-abc',
    challenge: 'challenge-xyz',
  };

  it('asks for a code with S256, not an implicit token', () => {
    const url = new URL(googleAuthorizeUrl(input));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('state')).toBe('state-abc');
  });

  it('requests only identity scopes', () => {
    // Anything beyond this puts unnecessary permissions on the consent screen in
    // front of every new user.
    expect(new URL(googleAuthorizeUrl(input)).searchParams.get('scope')).toBe(
      'openid email profile',
    );
  });

  it('never carries the client secret or the verifier', () => {
    const url = googleAuthorizeUrl(input);
    expect(url).not.toContain('client_secret');
    expect(url).not.toContain('code_verifier');
  });

  it('encodes the redirect URI rather than splicing it in raw', () => {
    expect(new URL(googleAuthorizeUrl(input)).searchParams.get('redirect_uri')).toBe(
      input.redirectUri,
    );
  });
});

describe('googleRedirectUri', () => {
  it('points at the callback page and nothing else', () => {
    // Must match the Authorised redirect URI registered with Google character
    // for character, or the handshake fails with redirect_uri_mismatch.
    expect(googleRedirectUri('https://app.example.com')).toBe(
      'https://app.example.com/auth/callback/google',
    );
    expect(googleRedirectUri('http://localhost:3000')).toBe(
      'http://localhost:3000/auth/callback/google',
    );
  });
});

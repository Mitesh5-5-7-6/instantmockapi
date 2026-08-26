import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import type { EnvConfig } from '@instantmockapi/config';
import { verifyGoogleCode } from './google.js';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';

function config(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    googleClientId: CLIENT_ID,
    googleClientSecret: 'client-secret',
    ...overrides,
  } as EnvConfig;
}

const exchange = { code: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://app/cb' };

let privateKey: CryptoKey;
let publicJwk: JWK;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * One RS256 key pair for the whole file, and Google's JWKS endpoint stubbed to
 * serve the public half. Verification is therefore genuine — `jose` checks the
 * signature against the key it fetched — rather than mocked away, which is the
 * only way these tests say anything about the checks that matter.
 *
 * **`beforeAll`, not `beforeEach`, and that is load-bearing.**
 * `createRemoteJWKSet` caches Google's keys at module scope and rate-limits
 * refetching, which is exactly right in production where those keys are stable
 * for weeks. A fresh pair per test would sign with a key the cache has never
 * seen, and every test after the first would fail on the signature rather than on
 * whatever it meant to check.
 */
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'test-key' };
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function idToken(
  claims: Record<string, unknown>,
  signWith: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'google-sub-1',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signWith);
}

/** Answer the token endpoint with `token`, and the JWKS endpoint with our key. */
function stubGoogle(token: string, tokenStatus = 200): void {
  fetchMock.mockImplementation(async (url: string | URL) => {
    const href = String(url);
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ id_token: token }), { status: tokenStatus });
    }
    if (href.includes('oauth2/v3/certs')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${href}`);
  });
}

describe('verifyGoogleCode', () => {
  it('returns the identity from a well-formed id_token', async () => {
    stubGoogle(await idToken({}));
    expect(await verifyGoogleCode(exchange, config())).toEqual({
      sub: 'google-sub-1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
  });

  it('sends the code, the secret and the PKCE verifier to the token endpoint', async () => {
    stubGoogle(await idToken({}));
    await verifyGoogleCode(exchange, config());

    const tokenCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('oauth2.googleapis.com/token'),
    );
    const body = new URLSearchParams((tokenCall?.[1] as RequestInit).body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    // The verifier is what makes an intercepted code useless.
    expect(body.get('code_verifier')).toBe(exchange.codeVerifier);
    // And the secret goes here, from the server — never through the browser.
    expect(body.get('client_secret')).toBe('client-secret');
  });

  /**
   * Without the audience check, an `id_token` minted for *any other* Google
   * application is accepted — and anyone can register one. This is the difference
   * between "signed in with Google" and "signed in as anyone".
   */
  it('rejects a token issued for a different Google application', async () => {
    stubGoogle(await idToken({ aud: 'someone-elses-client-id' }));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  it('rejects a token from the wrong issuer', async () => {
    stubGoogle(await idToken({ iss: 'https://evil.example.com' }));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  it('rejects a token signed by a different key', async () => {
    // Same `kid` in the header, so the JWKS lookup succeeds and the rejection is
    // genuinely on the signature rather than on a missing key.
    const impostor = await generateKeyPair('RS256');
    stubGoogle(await idToken({}, impostor.privateKey));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  it('rejects an expired token', async () => {
    const stale = await new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'google-sub-1',
      email: 'ada@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    stubGoogle(stale);
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  /**
   * A Google account can carry an address its owner never proved. Accepting one
   * would let somebody claim an existing InstantMockAPI account by adding its
   * address to their own Google profile.
   */
  it('rejects an unverified Google address, with a message that says why', async () => {
    stubGoogle(await idToken({ email_verified: false }));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/Confirm your email/i);
  });

  it('rejects a token missing sub or email', async () => {
    stubGoogle(await idToken({ email: undefined }));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  it('lower-cases the address', async () => {
    // Our own accounts are keyed on a lower-cased email; a mixed-case one from
    // Google would otherwise create a second account for the same person.
    stubGoogle(await idToken({ email: 'Ada@Example.COM' }));
    expect((await verifyGoogleCode(exchange, config())).email).toBe('ada@example.com');
  });

  it('tolerates an identity with no name', async () => {
    stubGoogle(await idToken({ name: undefined }));
    expect((await verifyGoogleCode(exchange, config())).name).toBeNull();
  });

  it('reports a rejected code exchange without leaking Google’s reason', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    // Google's message names the client id and redirect URI. That belongs in our
    // logs, not in a response body.
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
    await expect(verifyGoogleCode(exchange, config())).rejects.not.toThrow(/invalid_grant/);
  });

  it('survives a network failure reaching Google', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(verifyGoogleCode(exchange, config())).rejects.toThrow(/could not be completed/i);
  });

  it('carries an abort signal, so a hung Google cannot hold the request open', async () => {
    stubGoogle(await idToken({}));
    await verifyGoogleCode(exchange, config());
    const tokenCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('oauth2.googleapis.com/token'),
    );
    expect((tokenCall?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses before any network call when Google is not configured', async () => {
    await expect(verifyGoogleCode(exchange, config({ googleClientSecret: '' }))).rejects.toThrow(
      /not configured/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

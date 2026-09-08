import { describe, it, expect } from 'vitest';

import { bearerToken, durationSeconds, signMockToken, verifyMockToken } from './tokens.js';

/**
 * §14's isolation, and the two JWT mistakes that would defeat it silently.
 */

const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const PROJECT_A = '6a9f919cbcbe9d243bc01e2c';
const PROJECT_B = '6a9f919cbcbe9d243bc01e2d';

const sign = (over: Partial<Parameters<typeof signMockToken>[0]> = {}) =>
  signMockToken({
    secret: SECRET_A,
    projectId: PROJECT_A,
    userId: 'user_1',
    type: 'access',
    ttlSeconds: 900,
    ...over,
  });

const verify = (token: string, over: Partial<Parameters<typeof verifyMockToken>[0]> = {}) =>
  verifyMockToken({
    secret: SECRET_A,
    projectId: PROJECT_A,
    token,
    expect: 'access',
    ...over,
  });

describe('a token round trips', () => {
  it('verifies against its own project and key', async () => {
    const { token } = await sign();
    const result = await verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user_1');
      expect(result.claims.type).toBe('access');
      expect(result.claims.projectId).toBe(PROJECT_A);
    }
  });

  it('reports when it expires, so the caller can store it', async () => {
    const before = Date.now();
    const { expiresAt } = await sign({ ttlSeconds: 900 });
    // Within a second of now + 900, allowing for the second-granularity claim.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 899_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 901_000);
  });

  /**
   * §7: minimal claims. A JWT is readable by anyone holding it, so an email in
   * the payload is an email in every log, proxy and browser devtools panel that
   * ever sees the header.
   */
  it('carries no user detail beyond the id', async () => {
    const { token } = await sign();
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'sub', 'type']);
    expect(JSON.stringify(payload)).not.toContain('@');
  });
});

describe('§14: a token from Project A cannot authenticate against Project B', () => {
  /**
   * The isolation is structural rather than a check that could be forgotten:
   * each project signs with its own key, so a foreign token fails the signature
   * before any claim is read.
   */
  it('fails on the signature when the key differs', async () => {
    const { token } = await sign();
    const result = await verify(token, { secret: SECRET_B, projectId: PROJECT_B });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('signature');
    }
  });

  /**
   * Defence in depth: even in the impossible case of two projects sharing a
   * key, the audience claim still rejects the token.
   */
  it('fails on the audience even when the key is somehow shared', async () => {
    const { token } = await sign();
    const result = await verify(token, { projectId: PROJECT_B });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong-audience');
    }
  });
});

describe('a refresh token is not an access token', () => {
  /**
   * The single most common JWT mistake. Both are signed with the same key, so
   * without the `type` claim a refresh token verifies perfectly as an access
   * token — and lives seven days rather than fifteen minutes.
   */
  it('refuses a refresh token where an access token is expected', async () => {
    const { token } = await sign({ type: 'refresh', ttlSeconds: 604_800 });
    const result = await verify(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong-type');
    }
  });

  it('refuses an access token where a refresh token is expected', async () => {
    const { token } = await sign();
    const result = await verify(token, { expect: 'refresh' });
    expect(result.ok).toBe(false);
  });
});

describe('rejections', () => {
  it('reports an expired token as expired, not as malformed', async () => {
    // A negative TTL puts `exp` in the past, which is what a real lapse looks
    // like — and the client's remedy is to refresh, not to sign in again.
    const { token } = await sign({ ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await verify(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('rejects garbage without throwing', async () => {
    for (const token of ['', 'not-a-jwt', 'a.b.c', 'Bearer x']) {
      const result = await verify(token);
      expect(result.ok, token).toBe(false);
    }
  });

  it('rejects a token whose payload was edited', async () => {
    const { token } = await sign();
    const [header, payload, signature] = token.split('.');
    const tampered = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    tampered['sub'] = 'someone_else';
    const forged = [
      header,
      Buffer.from(JSON.stringify(tampered)).toString('base64url'),
      signature,
    ].join('.');

    const result = await verify(forged);
    expect(result.ok).toBe(false);
  });
});

describe('bearerToken', () => {
  it('reads a well-formed header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
  });

  it('is null for anything else', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer   ')).toBeNull();
  });
});

describe('durationSeconds', () => {
  it('reads the grammar the config is validated against', () => {
    expect(durationSeconds('900s', 0)).toBe(900);
    expect(durationSeconds('15m', 0)).toBe(900);
    expect(durationSeconds('24h', 0)).toBe(86_400);
    expect(durationSeconds('7d', 0)).toBe(604_800);
  });

  /**
   * Falls back rather than throwing: this reads a *stored* configuration, and a
   * document written before the grammar was enforced must still be servable.
   * `validateIPS` is what stops a new one being written.
   */
  it('falls back on a value the validator would now reject', () => {
    expect(durationSeconds('900', 42)).toBe(42);
    expect(durationSeconds('', 42)).toBe(42);
    expect(durationSeconds('0m', 42)).toBe(42);
  });
});

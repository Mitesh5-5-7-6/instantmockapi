import { describe, it, expect } from 'vitest';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  extractBearerToken,
  type AuthUser,
} from './tokens.js';

const baseConfig: EnvConfig = { ...loadEnvConfig(), jwtSecret: 'test-secret', jwtExpiresIn: 3600 };

const user: AuthUser = {
  id: '507f1f77bcf86cd799439011',
  email: 'dev@example.com',
  plan: 'free',
};

describe('JWT issuance and verification', () => {
  it('round-trips an access token with full claims', async () => {
    const token = await issueAccessToken(user, baseConfig);
    const res = await verifyAccessToken(token, baseConfig);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.sub).toBe(user.id);
      expect(res.value.email).toBe(user.email);
      expect(res.value.plan).toBe('free');
      expect(res.value.tokenType).toBe('access');
    }
  });

  it('round-trips a refresh token', async () => {
    const token = await issueRefreshToken(user, baseConfig);
    const res = await verifyRefreshToken(token, baseConfig);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.tokenType).toBe('refresh');
    }
  });

  it('rejects a refresh token presented as an access token (and vice versa)', async () => {
    const refresh = await issueRefreshToken(user, baseConfig);
    const asAccess = await verifyAccessToken(refresh, baseConfig);
    expect(asAccess.ok).toBe(false);
    if (!asAccess.ok) {
      expect(asAccess.error.code).toBe('UNAUTHORIZED');
      expect(asAccess.error.statusCode).toBe(401);
    }

    const access = await issueAccessToken(user, baseConfig);
    const asRefresh = await verifyRefreshToken(access, baseConfig);
    expect(asRefresh.ok).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueAccessToken(user, { ...baseConfig, jwtSecret: 'other-secret' });
    const res = await verifyAccessToken(token, baseConfig);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects an expired access token', async () => {
    const token = await issueAccessToken(user, { ...baseConfig, jwtExpiresIn: -10 });
    const res = await verifyAccessToken(token, baseConfig);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects garbage tokens', async () => {
    const res = await verifyAccessToken('not-a-jwt', baseConfig);
    expect(res.ok).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    const res = extractBearerToken('Bearer abc.def.ghi');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe('abc.def.ghi');
    }
  });

  it.each([undefined, '', 'abc.def.ghi', 'bearer abc', 'Basic abc', 'Bearer ', 'Bearer    '])(
    'rejects malformed header %j',
    (header) => {
      const res = extractBearerToken(header as string | undefined);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('UNAUTHORIZED');
      }
    },
  );
});

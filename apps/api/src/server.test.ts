import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
    enqueueGenerationJob: vi.fn(async (...args: unknown[]) => ({ id: args[4] })),
  };
});

import type { FastifyInstance } from 'fastify';
import {
  authHeader,
  buildTestServer,
  clearDb,
  login,
  startTestDb,
  stopTestDb,
} from './testing/harness.js';

let app: FastifyInstance;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(clearDb);

describe('auth contract', () => {
  it('rejects requests without a token with a 401 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('rejects a malformed bearer token with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeader('not.a.token'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('login issues a token pair and creates the user once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'Dev@Example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toMatchObject({ email: 'dev@example.com', plan: 'free' });

    // Second login with the same email returns the same user
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'dev@example.com' },
    });
    expect(again.json().user.id).toBe(body.user.id);
  });

  it('rejects an invalid login body with a 400 envelope and details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual(expect.any(Array));
  });

  it('GET /v1/me returns the authenticated user', async () => {
    const session = await login(app, 'me@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      id: session.userId,
      email: 'me@example.com',
      plan: 'free',
    });
  });

  it('refresh exchanges a refresh token for a new pair', async () => {
    const session = await login(app, 'refresh@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeader(body.accessToken),
    });
    expect(me.statusCode).toBe(200);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const session = await login(app, 'refresh2@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.accessToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout returns 204', async () => {
    const session = await login(app, 'bye@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('error envelope', () => {
  it('unknown routes return a 404 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('healthz is open and healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('rate limiting', () => {
  it('returns 429 with the envelope and Retry-After once the bucket is empty', async () => {
    const limited = await buildTestServer({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    try {
      const first = await limited.inject({ method: 'GET', url: '/healthz' });
      const second = await limited.inject({ method: 'GET', url: '/healthz' });
      const third = await limited.inject({ method: 'GET', url: '/healthz' });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(third.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});

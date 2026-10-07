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
  REFRESH_COOKIE,
  authHeader,
  buildTestServer,
  clearDb,
  csrfHeader,
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
      error: {
        code: 'UNAUTHORIZED',
        message: expect.any(String),
        // Every failure carries a correlation id, echoed in `x-request-id`, so a
        // user reporting one can hand over something findable in the logs.
        requestId: expect.stringMatching(/^req_[0-9a-f]+$/),
      },
    });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]+$/);
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

  /**
   * The development-only route the whole suite signs in with. It is not
   * registered when `nodeEnv` is production — see the guard in routes/auth.ts.
   */
  it('dev-login issues a session and creates the user once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
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
      url: '/v1/auth/dev-login',
      payload: { email: 'dev@example.com' },
    });
    expect(again.json().user.id).toBe(body.user.id);
  });

  it('rejects an invalid login body with a 400 envelope and details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: 'correct horse battery' },
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

  /**
   * The refresh token now arrives as a cookie, not in the body — see
   * auth-cookies.ts for why. `csrfHeader()` is required on every
   * cookie-authenticated route.
   */
  it('refresh exchanges the cookie for a fresh access token', async () => {
    const session = await login(app, 'refresh@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: csrfHeader(),
      cookies: { [REFRESH_COOKIE]: session.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    // No refresh token in the body: it never leaves the httpOnly cookie.
    expect(body.refreshToken).toBeUndefined();

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
      headers: csrfHeader(),
      cookies: { [REFRESH_COOKIE]: session.accessToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refresh with no cookie is a clean 401, which is how a fresh visitor boots', async () => {
    // The web app calls this on load to find out whether it has a session, so
    // "no cookie" has to be an ordinary answer rather than an error condition.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: csrfHeader(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('logout returns 204 and clears the cookie', async () => {
    const session = await login(app, 'bye@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...authHeader(session.accessToken), ...csrfHeader() },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain(REFRESH_COOKIE);
  });
});

describe('CORS (web app is a separate origin)', () => {
  it('answers preflight with the allowed origin and methods', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/projects',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('stamps allow-origin on actual responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});

describe('error envelope', () => {
  it('unknown routes return a 404 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('health/live is open and healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  /**
   * The build stamp, which is what makes "is my fix deployed?" answerable from
   * a client. Twice now a failure has been indistinguishable between "the
   * request is wrong" and "the deployed code predates the fix", and neither
   * could be settled without shell access to the host.
   *
   * Null locally: `RENDER_GIT_COMMIT` is set by the platform, so there is no
   * build step and no generated file to keep in step.
   */
  it('health/live reports which build is answering', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    const body = res.json() as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['branch', 'commit', 'startedAt', 'status']);
    expect(body['commit']).toBeNull();
    expect(body['branch']).toBeNull();
    // Distinguishes "deployed but not restarted" from "never deployed", which
    // a commit SHA alone cannot.
    expect(typeof body['startedAt']).toBe('string');
  });

  /**
   * Open, deliberately.
   *
   * Putting the stamp behind authentication would put it out of reach of
   * exactly the debugging session that needs it. A commit SHA of a private
   * repository is not a credential and cannot be exchanged for source.
   */
  it('needs no token to report the build', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    // And nothing sensitive rides along.
    expect(res.body).not.toMatch(/secret|password|token|mongodb:|redis:/i);
  });
});

describe('rate limiting', () => {
  it('returns 429 with the envelope and Retry-After once the bucket is empty', async () => {
    const limited = await buildTestServer({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    try {
      const first = await limited.inject({ method: 'GET', url: '/health/live' });
      const second = await limited.inject({ method: 'GET', url: '/health/live' });
      const third = await limited.inject({ method: 'GET', url: '/health/live' });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(third.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });

  /**
   * The bug this pins down was live in production.
   *
   * The limiter keys unauthenticated requests on `request.ip`, and behind a load
   * balancer that is the balancer's address unless `trustProxy` is set — so every
   * caller on the internet shared one bucket. `SIGNUP_LIMIT` is 5/hour, which
   * made it five signups an hour *for the entire platform*.
   *
   * Note what is asserted: that two different forwarded addresses get
   * **separate budgets**. A test that only checked `request.ip` was non-empty
   * passed the whole time the bug existed, because the proxy's address is a
   * perfectly valid non-empty string.
   */
  it('gives two different client addresses separate budgets', async () => {
    const limited = await buildTestServer({ rateLimit: { max: 1, timeWindowMs: 60_000 } });
    try {
      const get = (forwardedFor: string) =>
        limited.inject({
          method: 'GET',
          url: '/health/live',
          headers: { 'x-forwarded-for': forwardedFor },
        });

      expect((await get('203.0.113.1')).statusCode).toBe(200);
      // Same caller, budget spent.
      expect((await get('203.0.113.1')).statusCode).toBe(429);
      // Different caller, untouched budget. Without trustProxy this is a 429,
      // because both requests resolve to the proxy's address.
      expect((await get('198.51.100.7')).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  /**
   * `trustProxy: 1` rather than `true`.
   *
   * `true` walks the whole `X-Forwarded-For` chain to its leftmost entry, which
   * is attacker-controlled: prepending a fresh fake address to every request
   * yields a fresh bucket every time and defeats the limit entirely. Trusting one
   * hop means only the address the real proxy appended is believed.
   */
  it('ignores forged entries prepended to the forwarded chain', async () => {
    const limited = await buildTestServer({ rateLimit: { max: 1, timeWindowMs: 60_000 } });
    try {
      const spoof = (fake: string) =>
        limited.inject({
          method: 'GET',
          url: '/health/live',
          // The rightmost entry is what the proxy appended; everything left of it
          // came from the client.
          headers: { 'x-forwarded-for': `${fake}, 203.0.113.1` },
        });

      expect((await spoof('1.1.1.1')).statusCode).toBe(200);
      // A new fake address must NOT buy a new budget — the trusted hop is
      // unchanged, so this is the same caller.
      expect((await spoof('2.2.2.2')).statusCode).toBe(429);
      expect((await spoof('3.3.3.3')).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('request correlation', () => {
  /**
   * A user reporting "saving failed" needs to hand over something findable.
   * Fastify's default `genReqId` is a per-process counter — `req-1`, `req-2` —
   * which restarts at 1 on every deploy and collides across instances, so two
   * unrelated failures a week apart can carry the same id.
   */
  it('stamps a distinct id on every response, not a counter', async () => {
    const first = await app.inject({ method: 'GET', url: '/health/live' });
    const second = await app.inject({ method: 'GET', url: '/health/live' });

    for (const res of [first, second]) {
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{10}$/);
    }
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  /** Successes carry it too: a wrong-looking 200 needs the same handle as a 500. */
  it('stamps successes as well as failures', async () => {
    const ok = await app.inject({ method: 'GET', url: '/health/live' });
    const missing = await app.inject({ method: 'GET', url: '/v1/nope' });

    expect(ok.statusCode).toBeLessThan(400);
    expect(ok.headers['x-request-id']).toBeTruthy();
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.requestId).toBe(missing.headers['x-request-id']);
  });

  /**
   * An inbound id is honoured so a request traced through another service keeps
   * one id end to end — but validated first. An unchecked header is a
   * log-injection vector and a way to make two requests share an id.
   */
  it('honours a well-formed inbound id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req_abcdef0123' },
    });
    expect(res.headers['x-request-id']).toBe('req_abcdef0123');
  });

  it.each(['nonsense', 'req_NOTHEX', '', 'req_' + 'a'.repeat(64), '<script>alert(1)</script>'])(
    'mints its own id rather than trusting %o',
    async (inbound) => {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': inbound },
      });
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{10}$/);
      expect(res.headers['x-request-id']).not.toBe(inbound);
    },
  );

  /** The ajv-validation branch of the error handler needs the id too. */
  it('stamps a schema-validation failure', async () => {
    const session = await login(app, 'correlate@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeader(session.accessToken),
      payload: { nope: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.requestId).toMatch(/^req_[0-9a-f]+$/);
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { registerErrorHandling } from './error-handler.js';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  clearRefreshCookie,
  readRefreshCookie,
  requireCsrfHeader,
  setRefreshCookie,
} from './auth-cookies.js';

const WEB_ORIGIN = 'https://app.example.com';

/**
 * A miniature server exercising only the cookie helpers, so the assertions are
 * about `Set-Cookie` rather than about whichever auth route happens to call them.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandling(app);
  await app.register(cors, {
    origin: WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', CSRF_HEADER],
  });
  await app.register(cookie);

  app.post('/set', async (_request, reply) => {
    setRefreshCookie(reply, 'token-value');
    return { ok: true };
  });
  app.post('/clear', async (_request, reply) => {
    clearRefreshCookie(reply);
    return { ok: true };
  });
  app.post('/read', async (request) => ({ token: readRefreshCookie(request) }));
  app.post(
    '/guarded',
    { onRequest: [async (request) => requireCsrfHeader(request)] },
    async () => ({
      ok: true,
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function setCookieHeader(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  return Array.isArray(raw) ? (raw[0] as string) : (raw as string);
}

describe('the refresh cookie attributes', () => {
  /**
   * Asserted literally, because every one of these is load-bearing and a silent
   * change to any of them is either a security regression or a total sign-in
   * failure that only appears in a deployed cross-origin setup.
   */
  it('is HttpOnly, Secure, SameSite=None and scoped to the auth routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/set' });
    const header = setCookieHeader(res.headers);

    expect(header).toContain(`${REFRESH_COOKIE}=token-value`);
    // HttpOnly: unreadable by script, so an XSS bug cannot exfiltrate a durable
    // credential.
    expect(header).toContain('HttpOnly');
    // Secure: never sent over plaintext. Works in development too, because
    // browsers treat http://localhost as a secure context.
    expect(header).toContain('Secure');
    // None: the web app and the API are different sites, so anything stricter
    // means the cookie is simply never sent and nobody can stay signed in.
    expect(header).toMatch(/SameSite=None/i);
    expect(header).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    // Host-only: no Domain attribute, so it is not shared with sibling
    // subdomains.
    expect(header).not.toMatch(/Domain=/i);
  });

  it('outlives a browser session, so a refresh restores the session', async () => {
    const header = setCookieHeader((await app.inject({ method: 'POST', url: '/set' })).headers);
    // A session cookie (no Max-Age) would sign the user out on every browser
    // restart, which is the thing this cookie exists to prevent.
    expect(header).toMatch(/Max-Age=\d+/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(24 * 3600);
  });

  /**
   * A browser keys a cookie on name + path, so clearing with a different path
   * writes a *second* expired cookie and leaves the real one in place — the user
   * appears signed out until the next refresh silently signs them back in.
   */
  it('clears with the same path it was set with', async () => {
    const setHeader = setCookieHeader((await app.inject({ method: 'POST', url: '/set' })).headers);
    const clearHeader = setCookieHeader(
      (await app.inject({ method: 'POST', url: '/clear' })).headers,
    );

    expect(clearHeader).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(clearHeader).toContain('HttpOnly');
    expect(clearHeader).toMatch(/SameSite=None/i);
    // Same attributes as the set, minus the lifetime.
    for (const attribute of ['HttpOnly', 'Secure', `Path=${REFRESH_COOKIE_PATH}`]) {
      expect(setHeader).toContain(attribute);
      expect(clearHeader).toContain(attribute);
    }
    expect(clearHeader).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });
});

describe('readRefreshCookie', () => {
  it('reads the value the browser sends back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/read',
      cookies: { [REFRESH_COOKIE]: 'abc' },
    });
    expect(res.json()).toEqual({ token: 'abc' });
  });

  it('returns null when there is no cookie at all', async () => {
    expect((await app.inject({ method: 'POST', url: '/read' })).json()).toEqual({ token: null });
  });

  it('treats an empty cookie as absent', async () => {
    // A cleared cookie can arrive as an empty value rather than not at all;
    // passing '' downstream would produce a confusing token-verification error
    // instead of a clean "not signed in".
    const res = await app.inject({
      method: 'POST',
      url: '/read',
      cookies: { [REFRESH_COOKIE]: '' },
    });
    expect(res.json()).toEqual({ token: null });
  });
});

describe('the CSRF header guard', () => {
  it('allows a request carrying the header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    });
    expect(res.statusCode).toBe(200);
  });

  /**
   * The attack this stops: a page on another site containing
   * `<form action="…/v1/auth/refresh" method="post">`. SameSite=None means the
   * browser attaches the cookie, and a form cannot set a custom header — so the
   * request arrives without one and is refused here.
   */
  it('refuses a request with no header, which is what a cross-site form sends', async () => {
    const res = await app.inject({ method: 'POST', url: '/guarded' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('refuses a wrong value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { [CSRF_HEADER]: 'XMLHttpRequest' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('credentialed CORS', () => {
  /**
   * Without this header the browser discards the response of any request made
   * with `credentials: 'include'` — the refresh call would appear to fail for no
   * visible reason.
   */
  it('allows credentials from the web origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/read',
      headers: { origin: WEB_ORIGIN },
    });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });

  /**
   * This is what makes the CSRF guard effective, and it is worth being precise
   * about where the enforcement happens: **in the browser, not here.**
   *
   * Configured with a fixed origin string, `@fastify/cors` echoes that same
   * string back whatever origin asked — it does not compare and it does not
   * reject. What stops an attacker is that the browser compares: it sees
   * `Access-Control-Allow-Origin: https://app.example.com`, finds it does not
   * match the requesting page's own origin, fails the preflight, and never
   * sends the real request. So the custom CSRF header cannot be delivered
   * cross-origin at all.
   *
   * The property to hold onto, therefore, is that the response names only the
   * web origin and never reflects the caller's — reflecting it is the mistake
   * that would make every origin allowed.
   */
  it('never reflects a foreign origin back to the caller', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/guarded',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': CSRF_HEADER,
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    // A wildcard would be worse than useless here: a browser refuses to send
    // credentials to '*', so this would break sign-in and open the API at once.
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('passes the preflight for the custom header from the web origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/guarded',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': CSRF_HEADER,
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      CSRF_HEADER,
    );
  });
});

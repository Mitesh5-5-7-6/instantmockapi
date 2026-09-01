/**
 * CORS on the hosted mock API.
 *
 * A public mock URL is called from a browser — the web playground, and whatever
 * app the user is building against it. That makes the preflight response part of
 * the product surface, not infrastructure detail.
 *
 * These live in their own file because they need no database, no storage and no
 * seeded project: a preflight is answered before any route handler runs, so the
 * whole `runtime.test.ts` fixture would be setup for nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HTTP_METHODS } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import { createMemoryStorage } from '@instantmockapi/storage';
import { createMemoryCache } from './cache.js';
import { buildMockRuntime } from './server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildMockRuntime({
    config: loadEnvConfig(),
    storage: createMemoryStorage(),
    // In-memory: a preflight never reaches a cache read, and this keeps the
    // file free of any Redis or Mongo dependency.
    cache: createMemoryCache(),
    rateLimit: false,
  });
});

afterAll(async () => {
  await app.close();
});

const ORIGIN = 'https://instantmockapi.vercel.app';

function preflight(method: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/p/prj_abc1234567/shop/customer/c-1',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type',
    },
  });
}

describe('the CORS preflight', () => {
  /**
   * The bug this exists to prevent, which was live in production.
   *
   * `@fastify/cors` defaults `methods` to `'GET,HEAD,POST'` — not the wider set
   * it is easy to assume. Registering it as `{ origin: true }` therefore answered
   * the preflight for PATCH with a cheerful **204** that advertised only three
   * methods, so the browser blocked the real request with an opaque "CORS error"
   * and every write method was unusable from a browser.
   *
   * `curl` is unaffected — it does not enforce CORS — which is exactly why this
   * survived until the playground became the first browser client to attempt a
   * write.
   *
   * Note what is asserted: the *advertised methods*, not the status code. The
   * status was 204 the entire time the bug existed.
   */
  it('advertises every method the runtime serves', async () => {
    const res = await preflight('PATCH');
    const allowed = String(res.headers['access-control-allow-methods'])
      .split(',')
      .map((method) => method.trim().toUpperCase());

    for (const method of HTTP_METHODS) {
      expect(allowed).toContain(method);
    }
  });

  it.each([...HTTP_METHODS])('lets a browser send %s', async (method) => {
    const res = await preflight(method);
    // 204 alone proves nothing — see above. The allow-methods list is the gate.
    expect(res.statusCode).toBeLessThan(300);
    expect(String(res.headers['access-control-allow-methods'])).toContain(method);
  });

  it('reflects the calling origin', async () => {
    // A hosted mock is called from anywhere: a deployed app, a local dev server
    // on a random port, CodeSandbox. There is no origin list to keep.
    for (const origin of [ORIGIN, 'http://localhost:5173', 'https://example.test']) {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/p/prj_abc1234567/shop/customer',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('allows the content-type header writes need', async () => {
    // Without it a JSON body is refused: `content-type: application/json` is not
    // CORS-safelisted, so a POST or PATCH carrying one needs it named here.
    const res = await preflight('POST');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'content-type',
    );
  });

  /**
   * The mock API is deliberately credential-free: it has no cookies, no sessions
   * and no auth. Allowing credentials would be the one change that makes
   * reflecting every origin dangerous rather than merely permissive.
   */
  it('does not allow credentials', async () => {
    const res = await preflight('GET');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the preflight without resolving the project', async () => {
    // The project id above does not exist. A preflight must still succeed — it is
    // answered before routing, and a 404 here would make the browser report a
    // CORS failure for what is really a missing project.
    const res = await preflight('GET');
    expect(res.statusCode).toBeLessThan(300);
  });
});

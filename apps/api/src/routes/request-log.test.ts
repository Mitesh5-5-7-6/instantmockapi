import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

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
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
} from '../testing/harness.js';

/**
 * The request log, as wired (Phase 6 §12).
 *
 * `packages/shared/src/request-log.test.ts` covers the cold-start logic in
 * isolation. What is left, and what only a real server can answer, is whether
 * the hook is registered and whether the values it is handed are the ones
 * intended — specifically that Fastify's `routeOptions.url` is the route
 * *pattern* rather than the concrete path. That is an assumption about a
 * framework, so it is checked rather than trusted: if it returned the path, the
 * log would carry project ids and every endpoint would fragment into one line
 * per resource.
 *
 * Reading stdout is not elegant, but it is what an operator reads, and the
 * alternative — asserting the observer was constructed — would pass while the
 * hook emitted nothing.
 */
let app: FastifyInstance;
let token: string;
let lines: Record<string, unknown>[];
let spy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
}, 600_000);

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearDb();
  token = (await login(app, 'owner@example.com')).accessToken;
  lines = [];
  // The shared logger writes JSON lines through console.log; anything that is
  // not our request line is ignored rather than asserted on.
  spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const first = args[0];
    if (typeof first !== 'string') {
      return;
    }
    try {
      const parsed = JSON.parse(first) as { message?: string; context?: Record<string, unknown> };
      if (parsed.message === 'request' && parsed.context) {
        lines.push(parsed.context);
      }
    } catch {
      /* not a structured line */
    }
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe('§12: every request is logged', () => {
  it('emits one line with the fields an operator needs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: authHeader(token),
    });
    expect(response.statusCode).toBe(200);

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line['service']).toBe('api');
    expect(line['method']).toBe('GET');
    expect(line['route']).toBe('/v1/projects');
    expect(line['status']).toBe(200);
    expect(line['requestId']).toMatch(/^req_[0-9a-f]+$/);
    expect(typeof line['durationMs']).toBe('number');
    expect(typeof line['uptimeMs']).toBe('number');
    expect(typeof line['coldStart']).toBe('boolean');
  });

  /**
   * The framework assumption, checked.
   *
   * `routeOptions.url` must be the pattern. If Fastify returned the concrete
   * path, this log would contain a project id — and each project would get its
   * own "endpoint" in any per-route view built on it.
   */
  it('logs the route pattern, not the concrete path', async () => {
    const projectId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    lines = [];

    await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!['route']).toBe('/v1/projects/:id');
    expect(lines[0]!['route']).not.toContain(projectId);
  });

  it('logs failures too, with their status', async () => {
    await app.inject({ method: 'GET', url: '/v1/projects' });

    expect(lines).toHaveLength(1);
    expect(lines[0]!['status']).toBe(401);
  });

  /**
   * An unrouted path must not put a caller-controlled string in the log — that
   * is a log-injection vector and the reason the fallback is a literal rather
   * than `request.url`.
   */
  it('does not log a caller-supplied path when nothing matched', async () => {
    await app.inject({ method: 'GET', url: '/v1/definitely-not-a-route-<script>' });

    expect(lines).toHaveLength(1);
    expect(lines[0]!['route']).toBe('(unrouted)');
    expect(JSON.stringify(lines[0])).not.toContain('script');
  });

  /**
   * The correlation id in the log is the one the caller was handed, so a user
   * reporting "request req_abc failed" is findable. Asserting they match is
   * what makes that true rather than plausible.
   */
  it('logs the same request id the caller received', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: authHeader(token),
    });

    expect(lines[0]!['requestId']).toBe(response.headers['x-request-id']);
  });
});

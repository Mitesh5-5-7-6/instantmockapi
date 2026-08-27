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
import { ApiLog, mongoose } from '@instantmockapi/db';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
} from '../testing/harness.js';

let app: FastifyInstance;
let token: string;
let projectId: string;

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
  const session = await login(app, 'owner@example.com');
  token = session.accessToken;
  const created = await createProjectViaApi(app, token, 'Shop');
  projectId = created.json().id as string;
});

const HOUR = 60 * 60 * 1000;

/** A real ObjectId — see the note in project-metrics.test.ts. */
async function logRequest(overrides: {
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number | null;
  entity?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  agoMs?: number;
}): Promise<void> {
  await ApiLog.create({
    projectId: new mongoose.Types.ObjectId(projectId),
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/customer',
    status: overrides.status ?? 200,
    at: new Date(Date.now() - (overrides.agoMs ?? HOUR)),
    durationMs: overrides.durationMs === undefined ? 50 : overrides.durationMs,
    entity: overrides.entity === undefined ? 'customer' : overrides.entity,
    shape: 'collection',
    // An explicit `undefined` check rather than `??`: these fields are nullable,
    // and `??` would substitute the default for a deliberate null — making it
    // impossible to seed the very rows that predate the field.
    ip: overrides.ip === undefined ? '203.0.113.1' : overrides.ip,
    userAgent: overrides.userAgent === undefined ? 'curl/8.4.0' : overrides.userAgent,
  });
}

function logs(query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/projects/${projectId}/logs${query}`,
    headers: authHeader(token),
  });
}

describe('GET /v1/projects/:id/logs', () => {
  it('returns an empty page for a project with no traffic', async () => {
    const res = await logs();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: [], meta: { page: 1, total: 0 } });
  });

  it('returns the row as recorded, including the raw path', async () => {
    // The whole value of a log is that it shows what was literally called. The
    // query string and record id are the point, not noise to be normalised away.
    await logRequest({ path: '/customer/c-1?include=orders', status: 200, durationMs: 84 });

    const row = (await logs()).json().data[0];
    expect(row).toMatchObject({
      method: 'GET',
      path: '/customer/c-1?include=orders',
      status: 200,
      durationMs: 84,
      entity: 'customer',
      ip: '203.0.113.1',
      userAgent: 'curl/8.4.0',
    });
    expect(row.at).toEqual(expect.any(String));
    expect(row.id).toEqual(expect.any(String));
  });

  it('orders newest first', async () => {
    await logRequest({ path: '/oldest', agoMs: 3 * HOUR });
    await logRequest({ path: '/newest', agoMs: 1 * HOUR });
    await logRequest({ path: '/middle', agoMs: 2 * HOUR });

    expect((await logs()).json().data.map((row: { path: string }) => row.path)).toEqual([
      '/newest',
      '/middle',
      '/oldest',
    ]);
  });

  it('renders a missing duration as null, never zero', async () => {
    // Rows predating the durationMs field carry no value. `0ms` would claim an
    // impossibly fast response.
    await logRequest({ durationMs: null });
    expect((await logs()).json().data[0].durationMs).toBeNull();
  });

  it('nulls the fields older rows never captured', async () => {
    await logRequest({ entity: null, ip: null, userAgent: null });
    expect((await logs()).json().data[0]).toMatchObject({
      entity: null,
      ip: null,
      userAgent: null,
    });
  });

  describe('pagination', () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i += 1) {
        await logRequest({ path: `/customer/${i}`, agoMs: (i + 1) * 60_000 });
      }
    });

    it('pages through the set with a stable total', async () => {
      const first = (await logs('?page=1&limit=2')).json();
      const second = (await logs('?page=2&limit=2')).json();

      expect(first.data).toHaveLength(2);
      expect(second.data).toHaveLength(2);
      expect(first.meta.total).toBe(5);
      expect(second.meta.total).toBe(5);
      // No overlap between pages.
      expect(first.data[0].id).not.toBe(second.data[0].id);
    });

    it('returns an empty page past the end rather than erroring', async () => {
      const res = await logs('?page=99&limit=2');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().meta.total).toBe(5);
    });

    it('refuses a limit above the cap instead of silently serving it', async () => {
      // Rejected at the schema, so a caller asking for 5,000 rows learns the
      // ceiling rather than receiving 100 and assuming that was everything.
      expect((await logs('?limit=500')).statusCode).toBe(400);
      expect((await logs('?limit=100')).statusCode).toBe(200);
    });

    it('publishes the retention ceiling', async () => {
      expect((await logs()).json().meta.retentionDays).toBe(30);
    });
  });

  describe('filters', () => {
    beforeEach(async () => {
      await logRequest({ method: 'GET', path: '/customer', status: 200 });
      await logRequest({ method: 'POST', path: '/customer', status: 201 });
      await logRequest({ method: 'GET', path: '/customer/nope', status: 404 });
      await logRequest({ method: 'GET', path: '/order', status: 500, entity: 'order' });
    });

    it('filters by method', async () => {
      expect((await logs('?method=POST')).json().data).toHaveLength(1);
      expect((await logs('?method=GET')).json().data).toHaveLength(3);
    });

    it('filters by status class, not exact code', async () => {
      // Nobody asks for "the 409s" nearly as often as "what failed", and the
      // runtime returns several different 4xx by design.
      const twoXX = (await logs('?status=2xx')).json().data;
      expect(twoXX).toHaveLength(2);
      expect((await logs('?status=4xx')).json().data).toHaveLength(1);
      expect((await logs('?status=5xx')).json().data).toHaveLength(1);
    });

    it('filters by entity', async () => {
      expect((await logs('?entity=order')).json().data).toHaveLength(1);
      expect((await logs('?entity=customer')).json().data).toHaveLength(3);
    });

    it('matches the path as a prefix', async () => {
      // Anchored on purpose: an unanchored pattern cannot use an index and would
      // scan every row in the window.
      expect((await logs('?q=/customer')).json().data).toHaveLength(3);
      expect((await logs('?q=/order')).json().data).toHaveLength(1);
      // A substring that is not a prefix must not match.
      expect((await logs('?q=nope')).json().data).toHaveLength(0);
    });

    it('combines filters', async () => {
      expect((await logs('?method=GET&status=4xx')).json().data).toHaveLength(1);
      expect((await logs('?method=POST&status=4xx')).json().data).toHaveLength(0);
    });

    it('counts the filtered set, not the whole collection', async () => {
      // Otherwise the pager offers pages the filter cannot fill.
      const body = (await logs('?status=5xx')).json();
      expect(body.data).toHaveLength(1);
      expect(body.meta.total).toBe(1);
    });

    /**
     * The path filter reaches a `$regex`. Unescaped, `(` alone is an
     * invalid-regex error — a 500 from a search box — and a crafted pattern is a
     * denial-of-service through catastrophic backtracking.
     */
    it('treats regex metacharacters in the search as literal text', async () => {
      await logRequest({ path: '/customer(1)' });

      const res = await logs('?q=/customer(1)');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);

      // A pattern that would match everything if interpreted as a regex must
      // match nothing, because no path literally begins with `.*`.
      const wildcard = await logs('?q=.*');
      expect(wildcard.statusCode).toBe(200);
      expect(wildcard.json().data).toHaveLength(0);
    });

    it('rejects an unknown status class and an unknown method', async () => {
      expect((await logs('?status=6xx')).statusCode).toBe(400);
      expect((await logs('?method=FETCH')).statusCode).toBe(400);
    });
  });

  describe('the time window', () => {
    it('excludes rows outside it', async () => {
      await logRequest({ path: '/recent', agoMs: 2 * HOUR });
      await logRequest({ path: '/old', agoMs: 10 * 24 * HOUR });

      expect((await logs('?days=7')).json().data).toHaveLength(1);
      expect((await logs('?days=30')).json().data).toHaveLength(2);
    });

    it('offers a one-day window the metrics endpoint does not', async () => {
      // "What happened in the last day" is the question people actually ask of a
      // log, and it has no equivalent on the aggregate side.
      await logRequest({ agoMs: 2 * HOUR });
      await logRequest({ agoMs: 3 * 24 * HOUR });
      expect((await logs('?days=1')).json().data).toHaveLength(1);
    });

    it('rejects a window beyond retention', async () => {
      expect((await logs('?days=90')).statusCode).toBe(400);
    });
  });

  describe('access', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/logs` });
      expect(res.statusCode).toBe(401);
    });

    it("is a 404 for another user's project", async () => {
      const stranger = await login(app, 'stranger@example.com');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/logs`,
        headers: authHeader(stranger.accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it('never returns another project’s rows', async () => {
      const other = await createProjectViaApi(app, token, 'Other');
      const otherId = other.json().id as string;
      await ApiLog.create({
        projectId: new mongoose.Types.ObjectId(otherId),
        method: 'GET',
        path: '/leaked',
        status: 200,
        at: new Date(),
      });
      await logRequest({ path: '/mine' });

      const paths = (await logs()).json().data.map((row: { path: string }) => row.path);
      expect(paths).toEqual(['/mine']);
    });
  });
});

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
import { ApiLog, Project, mongoose } from '@instantmockapi/db';
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

/**
 * Insert a log row.
 *
 * ⚠️ `projectId` is converted to a real `ObjectId` here. `ApiLog.create` would
 * cast a string for us — writes go through Mongoose's casting — but the *read*
 * side is an aggregation, which does not. Seeding with strings would therefore
 * store rows the pipeline cannot match, and every assertion below would fail for
 * a reason that has nothing to do with the code under test.
 */
async function logRequest(overrides: {
  projectId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number | null;
  entity?: string | null;
  shape?: 'index' | 'collection' | 'record' | null;
  ip?: string | null;
  userAgent?: string | null;
  agoMs?: number;
}): Promise<void> {
  const ago = overrides.agoMs ?? HOUR;
  await ApiLog.create({
    projectId: new mongoose.Types.ObjectId(overrides.projectId ?? projectId),
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/customer',
    status: overrides.status ?? 200,
    at: new Date(Date.now() - ago),
    durationMs: overrides.durationMs === undefined ? 50 : overrides.durationMs,
    entity: overrides.entity === undefined ? 'customer' : overrides.entity,
    shape: overrides.shape === undefined ? 'collection' : overrides.shape,
    // An explicit `undefined` check rather than `??`: these fields are nullable,
    // and `??` would substitute the default for a deliberate null — making it
    // impossible to seed the very rows that predate the field.
    ip: overrides.ip === undefined ? '203.0.113.1' : overrides.ip,
    userAgent: overrides.userAgent === undefined ? 'curl/8.4.0' : overrides.userAgent,
  });
}

function metrics(query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/projects/${projectId}/metrics${query}`,
    headers: authHeader(token),
  });
}

describe('GET /v1/projects/:id/metrics', () => {
  it('returns a fully zeroed payload for a project with no traffic', async () => {
    const res = await metrics();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.requests.total).toBe(0);
    // Null, not 0: there is no rate to report over zero requests, and 0% would
    // read as "everything failed".
    expect(body.requests.successRate).toBeNull();
    expect(body.requests.avgDurationMs).toBeNull();
    expect(body.requests.changePercent).toBeNull();
    expect(body.topEndpoints).toEqual([]);
    // The chart still gets a bucket per day so it renders a flat line rather
    // than collapsing.
    expect(body.requests.series).toHaveLength(7);
    expect(body.endpointNote).toBeNull();
  });

  /**
   * The trap this pins down: Mongoose casts values in *queries* but not inside
   * aggregation pipelines. `String(project._id)` in the `$match` matches nothing
   * and every figure comes back zero — which is indistinguishable from a project
   * that has no traffic. Asserting a **non-zero** total is what makes the test
   * capable of failing.
   */
  it('counts the traffic it was given', async () => {
    await logRequest({});
    await logRequest({});
    await logRequest({ status: 500 });

    const body = (await metrics()).json();
    expect(body.requests.total).toBe(3);
    expect(body.requests.serverErrorRate).toBeCloseTo(33.3, 0);
  });

  it('counts only the requested project', async () => {
    const other = await createProjectViaApi(app, token, 'Other');
    const otherId = other.json().id as string;
    await logRequest({});
    await logRequest({ projectId: otherId });
    await logRequest({ projectId: otherId });

    expect((await metrics()).json().requests.total).toBe(1);
  });

  it('excludes traffic outside the window', async () => {
    await logRequest({ agoMs: 2 * HOUR });
    await logRequest({ agoMs: 20 * 24 * HOUR });

    expect((await metrics('?days=7')).json().requests.total).toBe(1);
    expect((await metrics('?days=30')).json().requests.total).toBe(2);
  });

  it('reports the change against the preceding window of equal length', async () => {
    // Two now, one in the 7 days before that.
    await logRequest({ agoMs: HOUR });
    await logRequest({ agoMs: 2 * HOUR });
    await logRequest({ agoMs: 9 * 24 * HOUR });

    const body = (await metrics('?days=7')).json();
    expect(body.requests.total).toBe(2);
    expect(body.requests.previousTotal).toBe(1);
    expect(body.requests.changePercent).toBe(100);
  });

  it('treats 4xx as a client error and not a failure', async () => {
    // The runtime returns 4xx by design — 405 for an unselected method, 422 for
    // the user's own validation rules. Counting those as failures would punish
    // correct behaviour.
    await logRequest({ status: 200 });
    await logRequest({ status: 404 });

    const body = (await metrics()).json();
    expect(body.requests.successRate).toBe(100);
    expect(body.requests.clientErrorRate).toBe(50);
    expect(body.requests.serverErrorRate).toBe(0);
  });

  describe('durations', () => {
    it('averages only the rows that carry one', async () => {
      await logRequest({ durationMs: 100 });
      await logRequest({ durationMs: 200 });
      // Predates the durationMs field; averaging it as 0 would report 100ms.
      await logRequest({ durationMs: null });

      const body = (await metrics()).json();
      expect(body.requests.avgDurationMs).toBe(150);
      expect(body.requests.durationSampleCount).toBe(2);
      expect(body.requests.total).toBe(3);
    });

    it('reports null when nothing in the window was timed', async () => {
      await logRequest({ durationMs: null });
      const body = (await metrics()).json();
      expect(body.requests.avgDurationMs).toBeNull();
      expect(body.requests.durationSampleCount).toBe(0);
    });

    it('reports a latency delta only when both windows were sampled', async () => {
      await logRequest({ durationMs: 80, agoMs: HOUR });
      await logRequest({ durationMs: 120, agoMs: 9 * 24 * HOUR });

      const body = (await metrics('?days=7')).json();
      expect(body.requests.avgDurationMs).toBe(80);
      expect(body.requests.previousAvgDurationMs).toBe(120);
      // Negative is an improvement: responses got 40ms faster.
      expect(body.requests.durationChangeMs).toBe(-40);
    });

    it('reports a null delta when the previous window has no samples', async () => {
      // Rendering it as 0 would claim the latency was unchanged against a window
      // that was never measured.
      await logRequest({ durationMs: 80 });
      const body = (await metrics('?days=7')).json();
      expect(body.requests.durationChangeMs).toBeNull();
    });
  });

  describe('endpoint breakdown', () => {
    it('groups two record ids under one endpoint', async () => {
      // The reason `entity` + `shape` exist. `path` holds the raw URL, so
      // grouping on it would give one bucket per record.
      await logRequest({ path: '/customer/c-1', shape: 'record' });
      await logRequest({ path: '/customer/c-2', shape: 'record' });

      const body = (await metrics()).json();
      expect(body.topEndpoints).toHaveLength(1);
      expect(body.topEndpoints[0]).toMatchObject({
        method: 'GET',
        entity: 'customer',
        shape: 'record',
        count: 2,
      });
    });

    it('separates methods and shapes on the same entity', async () => {
      await logRequest({ shape: 'collection', method: 'GET' });
      await logRequest({ shape: 'collection', method: 'POST' });
      await logRequest({ shape: 'record', method: 'GET' });

      expect((await metrics()).json().topEndpoints).toHaveLength(3);
    });

    it('orders by request count, busiest first', async () => {
      await logRequest({ entity: 'order', shape: 'collection' });
      await logRequest({ entity: 'customer', shape: 'collection' });
      await logRequest({ entity: 'customer', shape: 'collection' });

      const top = (await metrics()).json().topEndpoints;
      expect(top[0]).toMatchObject({ entity: 'customer', count: 2 });
      expect(top[1]).toMatchObject({ entity: 'order', count: 1 });
    });

    /**
     * Rows logged before endpoint attribution existed, and 404s on unknown
     * entities, carry a null shape. They are real traffic and belong in the
     * totals; they are not endpoints, so they must not appear in a breakdown of
     * endpoints — and the difference has to be explained, or the panel reads as
     * a miscount against the total above it.
     */
    it('excludes unattributed rows but accounts for them', async () => {
      await logRequest({ shape: 'collection' });
      await logRequest({ entity: null, shape: null, status: 404 });
      await logRequest({ entity: null, shape: null });

      const body = (await metrics()).json();
      expect(body.requests.total).toBe(3);
      expect(body.topEndpoints).toHaveLength(1);
      expect(body.unattributedRequests).toBe(2);
      expect(body.endpointNote).toMatch(/attribution began/i);
    });

    it('stays silent when every request is attributed', async () => {
      await logRequest({ shape: 'collection' });
      const body = (await metrics()).json();
      expect(body.unattributedRequests).toBe(0);
      expect(body.endpointNote).toBeNull();
    });

    it('records the index route as an endpoint with no entity', async () => {
      await logRequest({ path: '/', entity: null, shape: 'index' });
      const top = (await metrics()).json().topEndpoints;
      expect(top).toHaveLength(1);
      expect(top[0]).toMatchObject({ entity: null, shape: 'index' });
    });
  });

  describe('the endpoint count', () => {
    it('counts endpoints and entities from the current schema, not from traffic', async () => {
      // Derived from the IPS × enabled methods, so it is correct before a single
      // request has ever been made.
      const body = (await metrics()).json();
      expect(body.endpoints.total).toBeGreaterThan(0);
      expect(body.endpoints.entities).toBeGreaterThan(0);
    });
  });

  describe('access and validation', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/metrics` });
      expect(res.statusCode).toBe(401);
    });

    it("is a 404 for another user's project, not a 403 with data", async () => {
      const stranger = await login(app, 'stranger@example.com');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/metrics`,
        headers: authHeader(stranger.accessToken),
      });
      // 404 rather than 403: a 403 would confirm the project id exists.
      expect(res.statusCode).toBe(404);
    });

    it('rejects a window the log cannot serve', async () => {
      // 90 days would return 30 days of data under a "90 days" heading — worse
      // than refusing, because it reads as a real answer.
      expect((await metrics('?days=90')).statusCode).toBe(400);
      expect((await metrics('?days=7')).statusCode).toBe(200);
    });

    it('publishes the retention ceiling so the UI can say so', async () => {
      expect((await metrics()).json().window.retentionDays).toBe(30);
    });
  });

  describe('activity', () => {
    it('reports only this project', async () => {
      const other = await createProjectViaApi(app, token, 'Other');
      await Project.updateOne({ _id: other.json().id }, { $set: { currentVersion: 2 } });

      const body = (await metrics()).json();
      for (const event of body.activity as { projectId: string }[]) {
        expect(event.projectId).toBe(projectId);
      }
    });

    it('honours the activity limit', async () => {
      expect((await metrics('?activityLimit=1')).json().activity.length).toBeLessThanOrEqual(1);
      expect((await metrics('?activityLimit=21')).statusCode).toBe(400);
    });
  });
});

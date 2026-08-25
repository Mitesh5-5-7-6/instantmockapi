import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Hoisted, and it must be the first statement: the harness pulls in
// @instantmockapi/queue transitively via generation-service, and without the mock
// BullMQ opens an ioredis socket that never closes and the suite hangs.
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
import { ApiLog, Project, User } from '@instantmockapi/db';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
  type TestSession,
} from '../testing/harness.js';

let app: FastifyInstance;
let session: TestSession;

/**
 * Frozen clock. Without this, "today's bucket" is whatever day the suite happens
 * to run on, and any test asserting a bucket date is flaky exactly once per day
 * at 23:59 — the kind of failure nobody ever reproduces.
 */
const NOW = new Date('2026-05-18T12:00:00.000Z');

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
  await stopTestDb();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await clearDb();
  session = await login(app, 'dash@example.com');
});

interface LogSeed {
  /** String id; the model casts it on insert. */
  projectId: string;
  at: string;
  status?: number;
  durationMs?: number | null;
  count?: number;
}

/** Seed request logs directly — the mock runtime is a different app entirely. */
async function seedLogs(seeds: LogSeed[]): Promise<void> {
  const rows = seeds.flatMap((seed) =>
    Array.from({ length: seed.count ?? 1 }, () => ({
      projectId: seed.projectId,
      method: 'GET',
      path: '/p/x/customer',
      status: seed.status ?? 200,
      at: new Date(seed.at),
      ...(seed.durationMs === undefined ? {} : { durationMs: seed.durationMs }),
    })),
  );
  await ApiLog.insertMany(rows);
}

async function fetchDashboard(query = ''): Promise<Record<string, any>> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/dashboard${query}`,
    headers: authHeader(session.accessToken),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function ownedProjectId(): Promise<string> {
  const created = await createProjectViaApi(app, session.accessToken);
  return created.json().id as string;
}

describe('GET /v1/dashboard — a brand-new account', () => {
  it('answers with a fully zeroed payload rather than nulls or a 500', async () => {
    // The most common state on a redesigned dashboard, and the likeliest place
    // for a divide-by-zero to reach the client.
    const body = await fetchDashboard();

    expect(body.projects).toMatchObject({ total: 0, createdInWindow: 0 });
    expect(body.endpoints.total).toBe(0);
    expect(body.requests.total).toBe(0);
    expect(body.requests.series).toHaveLength(7);
    expect(body.requests.series.every((bucket: { count: number }) => bucket.count === 0)).toBe(
      true,
    );
    expect(body.activity).toEqual([]);
    expect(body.hosted).toMatchObject({ live: 0, total: 0, soonestExpiresAt: null });
  });

  it('returns null — not NaN or 0 — for every rate with no traffic', async () => {
    const body = await fetchDashboard();
    expect(body.requests.changePercent).toBeNull();
    expect(body.requests.successRate).toBeNull();
    expect(body.requests.clientErrorRate).toBeNull();
    expect(body.requests.serverErrorRate).toBeNull();
    expect(body.requests.avgDurationMs).toBeNull();
    expect(body.requests.durationSampleCount).toBe(0);
  });
});

describe('GET /v1/dashboard — request metrics', () => {
  it('counts requests in the window and bucket-sums to the total', async () => {
    // The whole reason this is one $facet over one $match: the summary figure and
    // the chart are computed from the identical matched set, so they cannot
    // disagree. Asserted rather than assumed.
    const projectId = await ownedProjectId();
    await seedLogs([
      { projectId, at: '2026-05-13T08:00:00.000Z', count: 5 },
      { projectId, at: '2026-05-17T08:00:00.000Z', count: 3 },
      { projectId, at: '2026-05-18T08:00:00.000Z', count: 2 },
    ]);

    const body = await fetchDashboard();
    expect(body.requests.total).toBe(10);
    const summed = body.requests.series.reduce(
      (total: number, bucket: { count: number }) => total + bucket.count,
      0,
    );
    expect(summed).toBe(body.requests.total);
  });

  it('is a regression guard against stringified ObjectIds in the pipeline', async () => {
    // Mongoose casts queries but NOT aggregation pipelines. If anyone replaces
    // project._id with String(project._id), $in matches nothing and every figure
    // silently reads zero with no error. This assertion is the only thing that
    // catches it.
    const projectId = await ownedProjectId();
    await seedLogs([{ projectId, at: '2026-05-17T08:00:00.000Z', count: 4 }]);

    const body = await fetchDashboard();
    expect(body.requests.total).toBeGreaterThan(0);
    expect(body.requests.byProject[projectId]).toBe(4);
  });

  it('excludes rows outside the window and places boundary rows correctly', async () => {
    const projectId = await ownedProjectId();
    await seedLogs([
      // The window is [2026-05-12T00:00Z, 2026-05-19T00:00Z) for days=7.
      { projectId, at: '2026-05-11T23:59:59.999Z' }, // before → excluded
      { projectId, at: '2026-05-12T00:00:00.000Z' }, // first instant → included
      { projectId, at: '2026-05-18T23:59:59.999Z' }, // last instant → included
    ]);

    const body = await fetchDashboard();
    expect(body.requests.total).toBe(2);
    const byDate = new Map(
      body.requests.series.map((bucket: { date: string; count: number }) => [
        bucket.date,
        bucket.count,
      ]),
    );
    expect(byDate.get('2026-05-12')).toBe(1);
    expect(byDate.get('2026-05-18')).toBe(1);
  });

  it('compares against the previous equal-length window, not a calendar month', async () => {
    const projectId = await ownedProjectId();
    await seedLogs([
      { projectId, at: '2026-05-16T08:00:00.000Z', count: 12 }, // current window
      { projectId, at: '2026-05-08T08:00:00.000Z', count: 10 }, // previous window
    ]);

    const body = await fetchDashboard();
    expect(body.requests.total).toBe(12);
    expect(body.requests.previousTotal).toBe(10);
    expect(body.requests.changePercent).toBe(20);
  });

  it('treats 4xx as success and reports it separately', async () => {
    // 405 for an unselected method and 422 for the user's own validation rules
    // are by design. Counting them as errors would make the dashboard punish
    // someone for testing their schema.
    const projectId = await ownedProjectId();
    await seedLogs([
      { projectId, at: '2026-05-17T08:00:00.000Z', status: 200, count: 8 },
      { projectId, at: '2026-05-17T09:00:00.000Z', status: 405 },
      { projectId, at: '2026-05-17T10:00:00.000Z', status: 422 },
    ]);

    const body = await fetchDashboard();
    expect(body.requests.serverErrorRate).toBe(0);
    expect(body.requests.clientErrorRate).toBe(20);
    expect(body.requests.successRate).toBe(100);
  });

  it('counts 5xx against the success rate', async () => {
    const projectId = await ownedProjectId();
    await seedLogs([
      { projectId, at: '2026-05-17T08:00:00.000Z', status: 200, count: 9 },
      { projectId, at: '2026-05-17T09:00:00.000Z', status: 500 },
    ]);

    const body = await fetchDashboard();
    expect(body.requests.serverErrorRate).toBe(10);
    expect(body.requests.successRate).toBe(90);
  });

  it('averages only the rows that carry a duration', async () => {
    // Rows predating durationMs hold null and cannot be backfilled. Coercing
    // them to 0 would drag the mean toward zero for a whole retention window.
    const projectId = await ownedProjectId();
    await seedLogs([
      { projectId, at: '2026-05-17T08:00:00.000Z', durationMs: 100 },
      { projectId, at: '2026-05-17T09:00:00.000Z', durationMs: 200 },
      { projectId, at: '2026-05-17T10:00:00.000Z', durationMs: null },
      { projectId, at: '2026-05-17T11:00:00.000Z' },
    ]);

    const body = await fetchDashboard();
    expect(body.requests.total).toBe(4);
    expect(body.requests.avgDurationMs).toBe(150);
    expect(body.requests.durationSampleCount).toBe(2);
  });

  it('flags today as a partial bucket', async () => {
    const body = await fetchDashboard();
    const partial = body.requests.series.filter((bucket: { partial: boolean }) => bucket.partial);
    expect(partial).toHaveLength(1);
    expect(partial[0].date).toBe('2026-05-18');
  });

  it('names the window and its retention in the payload', async () => {
    // The disclaimer travels with the number, so any client renders an honest
    // label without having to know the TTL.
    const body = await fetchDashboard();
    expect(body.window).toMatchObject({ days: 7, tz: 'UTC', retentionDays: 30 });
    expect(body.requests.note).toContain('30 days');
  });
});

describe('GET /v1/dashboard — ownership isolation', () => {
  it('never counts another account, in any figure', async () => {
    // The security-relevant test. `ownerId` comes from the token subject, so a
    // regression here leaks another tenant's volume.
    const mine = await ownedProjectId();
    await seedLogs([{ projectId: mine, at: '2026-05-17T08:00:00.000Z', count: 2 }]);

    const stranger = await User.create({ email: 'other@example.com', authProvider: 'email' });
    const theirs = await Project.create({
      ownerId: stranger._id,
      name: 'Not Mine',
      status: 'active',
      inputSource: { type: 'json', raw: '{}' },
      ips: { projectId: 'x', version: 1, entities: [], generationConfig: {} },
      generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 1 },
      currentVersion: 1,
    });
    await seedLogs([{ projectId: String(theirs._id), at: '2026-05-17T08:00:00.000Z', count: 500 }]);

    const body = await fetchDashboard();
    expect(body.projects.total).toBe(1);
    expect(body.requests.total).toBe(2);
    expect(body.requests.byProject[String(theirs._id)]).toBeUndefined();
    expect(body.activity.every((entry: { projectId: string }) => entry.projectId === mine)).toBe(
      true,
    );
    expect(
      body.activity.some((entry: { projectName: string }) => entry.projectName === 'Not Mine'),
    ).toBe(false);
  });
});

describe('GET /v1/dashboard — projects, endpoints and plan', () => {
  it('counts endpoints with the shared counter, so it matches the Ready screen', async () => {
    // One entity from sampleRaw, all five methods → 6 rows + 1 discovery doc.
    await ownedProjectId();
    const body = await fetchDashboard();
    expect(body.endpoints.total).toBe(7);
    expect(body.projects.total).toBe(1);
  });

  it('reports the plan limits that are actually enforced', async () => {
    const body = await fetchDashboard();
    expect(body.plan).toMatchObject({
      tier: 'free',
      hostedApiLifetimeDays: 2,
    });
    expect(body.plan.projects).toMatchObject({ used: 0, limit: 10 });
    expect(body.plan.concurrentJobs).toMatchObject({ used: 0, limit: 1 });
  });

  it('groups projects by status and counts only live hosted APIs', async () => {
    const projectId = await ownedProjectId();
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          status: 'active',
          hosted: { url: 'https://x/p/1', expiresAt: new Date('2026-05-20T00:00:00.000Z') },
        },
      },
    );

    const body = await fetchDashboard();
    expect(body.projects.byStatus).toMatchObject({ active: 1 });
    expect(body.hosted).toMatchObject({ live: 1, total: 1 });
    expect(body.hosted.soonestExpiresAt).toBe('2026-05-20T00:00:00.000Z');
  });

  it('does not count an expired hosted API as live', async () => {
    const projectId = await ownedProjectId();
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          status: 'active',
          hosted: { url: 'https://x/p/1', expiresAt: new Date('2026-05-01T00:00:00.000Z') },
        },
      },
    );

    const body = await fetchDashboard();
    expect(body.hosted).toMatchObject({ live: 0, total: 1 });
  });
});

describe('GET /v1/dashboard — activity feed', () => {
  it('reports project creation with the verb matching how it was made', async () => {
    await ownedProjectId();
    const body = await fetchDashboard();
    expect(body.activity.length).toBeGreaterThanOrEqual(1);
    expect(
      body.activity.some((entry: { text: string }) => entry.text.includes('JSON sample')),
    ).toBe(true);
  });

  it('includes generation events, newest first', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const projectId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/generate`,
      headers: authHeader(session.accessToken),
      payload: {},
    });

    const body = await fetchDashboard();
    const types = body.activity.map((entry: { type: string }) => entry.type);
    expect(types).toContain('version.generated');

    const timestamps = body.activity.map((entry: { at: string }) => entry.at);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it('respects activityLimit', async () => {
    await ownedProjectId();
    await createProjectViaApi(app, session.accessToken, 'Second');
    const body = await fetchDashboard('?activityLimit=1');
    expect(body.activity).toHaveLength(1);
  });
});

describe('GET /v1/dashboard — request validation', () => {
  it('accepts only windows the retention period can actually serve', async () => {
    for (const days of [7, 14, 30]) {
      const body = await fetchDashboard(`?days=${days}`);
      expect(body.window.days).toBe(days);
      expect(body.requests.series).toHaveLength(days);
    }
  });

  it('rejects a window beyond retention rather than serving an empty half', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?days=90',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('strips an unknown query parameter rather than failing the request', async () => {
    // Fastify's default ajv config sets `removeAdditional`, so with
    // `additionalProperties: false` an unrecognised param is dropped, not
    // rejected. That is the behaviour every other route on this API already has,
    // and this endpoint is consumed by our own web app rather than by third
    // parties, so consistency beats strictness here.
    //
    // Deliberately unlike the HOSTED mock API, where an unknown filter is a 400:
    // there, silently ignoring `?nmae=` returns the full collection and reads as
    // "filtering is broken". Different surface, different audience.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?nope=1',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    // And it does not disturb the defaults it sits next to.
    expect(res.json().window.days).toBe(7);
    expect(res.json().activity).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });
});

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
import { Artifact, Job } from '@instantmockapi/db';
import { enqueueGenerationJob } from '@instantmockapi/queue';
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
let projectId: string;
let jobId: string;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer({ sse: { pollIntervalMs: 50, maxDurationMs: 10_000 } });
});

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearDb();
  vi.mocked(enqueueGenerationJob).mockClear();
  session = await login(app, 'owner@example.com');
  const created = await createProjectViaApi(app, session.accessToken);
  projectId = created.json().id;
  const generated = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/generate`,
    headers: authHeader(session.accessToken),
    payload: {},
  });
  jobId = generated.json().jobId;
});

describe('GET /v1/jobs/:jobId', () => {
  it('returns the job with per-worker status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: jobId,
      projectId,
      version: 1,
      type: 'full',
      status: 'queued',
    });
    expect(body.workers.length).toBeGreaterThan(0);
    expect(body.workers[0]).toMatchObject({ worker: expect.any(String), status: 'queued' });
    // Progress aggregator (doc 10 §8): nothing settled yet
    expect(body.progress).toEqual({ settled: 0, total: body.workers.length, percent: 0 });
  });

  it('reports progress as workers settle', async () => {
    await Job.updateOne(
      { _id: jobId, 'workers.worker': 'B' },
      { $set: { 'workers.$.status': 'completed' } },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: authHeader(session.accessToken),
    });
    const body = res.json();
    expect(body.progress.settled).toBe(1);
    expect(body.progress.percent).toBeGreaterThan(0);
  });

  it("returns 404 for another user's job and for unknown ids", async () => {
    const stranger = await login(app, 'stranger@example.com');
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: authHeader(stranger.accessToken),
    });
    expect(foreign.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/jobs/507f1f77bcf86cd799439011',
      headers: authHeader(session.accessToken),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('GET /v1/jobs/:jobId/stream (SSE)', () => {
  it('streams a snapshot and closes immediately for a terminal job', async () => {
    await Job.updateOne({ _id: jobId }, { $set: { status: 'completed' } });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/stream`,
      headers: authHeader(session.accessToken),
    });
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('event: snapshot');
    expect(res.body).toContain('"status":"completed"');
  });

  it('keeps streaming until the job reaches a terminal state', async () => {
    const pending = app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/stream`,
      headers: authHeader(session.accessToken),
    });

    // Let the stream start, then complete the job; the 50ms poll picks it up
    await new Promise((resolve) => setTimeout(resolve, 150));
    await Job.updateOne({ _id: jobId }, { $set: { status: 'completed' } });

    const res = await pending;
    const snapshots = res.body.split('\n\n').filter((chunk) => chunk.startsWith('event: snapshot'));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(res.body).toContain('"status":"completed"');
  });
});

describe('POST /v1/jobs/:jobId/workers/:worker/retry', () => {
  it('rejects retrying a worker that has not failed with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/workers/B/retry`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('rejects unknown worker ids with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/workers/Z/retry`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requeues a failed worker: job + registry reset, fresh enqueue', async () => {
    // Simulate Worker B having failed
    await Job.updateOne(
      { _id: jobId, 'workers.worker': 'B' },
      {
        $set: { 'workers.$.status': 'failed', 'workers.$.error': 'boom', status: 'failed_partial' },
      },
    );
    await Artifact.updateMany(
      { projectId, version: 1, artifactType: { $in: ['zod', 'yup'] } },
      { $set: { status: 'failed', errorMessage: 'boom' } },
    );
    vi.mocked(enqueueGenerationJob).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/workers/B/retry`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId, status: 'queued' });

    const job = await Job.findById(jobId);
    expect(job?.status).toBe('queued');
    const workerB = job?.workers.find((w) => w.worker === 'B');
    expect(workerB?.status).toBe('queued');
    expect(workerB?.error).toBeNull();

    // Worker B's registry rows are pending again
    const zodRow = await Artifact.findOne({ projectId, version: 1, artifactType: 'zod' });
    expect(zodRow?.status).toBe('pending');

    // Enqueued once, partial, only Worker B's artifacts, under a fresh key
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    const [calledProjectId, calledVersion, calledType, calledArtifacts, calledKey] =
      vi.mocked(enqueueGenerationJob).mock.calls[0] ?? [];
    expect(calledProjectId).toBe(projectId);
    expect(calledVersion).toBe(1);
    expect(calledType).toBe('partial');
    expect(calledArtifacts).toEqual(['zod', 'yup']);
    expect(String(calledKey)).toContain(':retry:B:');
  });
});

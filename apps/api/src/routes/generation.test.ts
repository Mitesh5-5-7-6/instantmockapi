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
import { Artifact, Job, Project, Version } from '@instantmockapi/db';
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

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
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
});

function generate(config?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/generate`,
    headers: authHeader(session.accessToken),
    payload: config ? { generationConfig: config } : {},
  });
}

describe('POST /v1/projects/:id/generate', () => {
  it('accepts with 202 { jobId, status: queued } and stages everything', async () => {
    const res = await generate();
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.jobId).toEqual(expect.any(String));

    // Project flips to generating
    const project = await Project.findById(projectId);
    expect(project?.status).toBe('generating');

    // Registry rows created pending for version 1
    const artifacts = await Artifact.find({ projectId, version: 1 });
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((a) => a.status === 'pending')).toBe(true);

    // Immutable version snapshot exists
    expect(await Version.countDocuments({ projectId, version: 1 })).toBe(1);

    // Job document carries per-worker entries and the BullMQ enqueue happened
    const job = await Job.findById(body.jobId);
    expect(job?.type).toBe('full');
    expect(job?.workers.length).toBeGreaterThan(0);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
  });

  it('deduplicates duplicate rapid calls via the idempotency key', async () => {
    const first = await generate();
    const second = await generate();

    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(await Job.countDocuments({})).toBe(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid generation config with 422', async () => {
    const res = await generate({
      validators: ['zod'],
      types: ['typescript'],
      methods: [],
      mockRecords: 25,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('free plan at its concurrency limit still gets 202 queued — never rejected', async () => {
    await generate();

    const second = await createProjectViaApi(app, session.accessToken, 'Second Project');
    const secondId = second.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${secondId}/generate`,
      headers: authHeader(session.accessToken),
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
    expect(await Job.countDocuments({})).toBe(2);
  });
});

describe('POST /v1/projects/:id/regenerate', () => {
  it('creates a distinct partial job for selected artifacts', async () => {
    const full = await generate();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(session.accessToken),
      payload: { artifacts: ['zod'] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).not.toBe(full.json().jobId);

    const job = await Job.findById(res.json().jobId);
    expect(job?.type).toBe('partial');
    expect(job?.requestedArtifacts).toEqual(['zod']);
    expect(job?.workers).toEqual([
      expect.objectContaining({ worker: 'B', artifactType: 'zod', status: 'queued' }),
    ]);
  });

  it('rejects unknown artifact types with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(session.accessToken),
      payload: { artifacts: ['ips'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('duplicate regenerate calls dedupe to the same job', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(session.accessToken),
      payload: { artifacts: ['zod', 'typescript'] },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(session.accessToken),
      payload: { artifacts: ['zod', 'typescript'] },
    });
    expect(second.json().jobId).toBe(first.json().jobId);
  });
});

describe('POST /v1/projects/:id/generate-again', () => {
  it('rejects non-expired projects with 409 CONFLICT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/generate-again`,
      headers: authHeader(session.accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('re-runs an expired project under a fresh version', async () => {
    await generate();
    await Project.updateOne({ _id: projectId }, { $set: { status: 'expired' } });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/generate-again`,
      headers: authHeader(session.accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(202);

    const project = await Project.findById(projectId);
    expect(project?.currentVersion).toBe(2);
    expect(project?.status).toBe('generating');

    const job = await Job.findById(res.json().jobId);
    expect(job?.version).toBe(2);
  });
});

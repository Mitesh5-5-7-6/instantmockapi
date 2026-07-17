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
import { Artifact } from '@instantmockapi/db';
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
  session = await login(app, 'owner@example.com');
  const created = await createProjectViaApi(app, session.accessToken);
  projectId = created.json().id;
  await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/generate`,
    headers: authHeader(session.accessToken),
    payload: {},
  });
});

describe('GET /v1/projects/:id/artifacts', () => {
  it('lists the registry rows for the current version', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ version: 1 });
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toMatchObject({
      projectId,
      version: 1,
      status: 'pending',
      artifactType: expect.any(String),
    });
  });

  it('fetches a single artifact record by type, 404 when absent', async () => {
    const hit = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod`,
      headers: authHeader(session.accessToken),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({ artifactType: 'zod', version: 1, status: 'pending' });

    // 'ips' is never staged as a worker artifact, so no registry row exists
    const miss = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/ips`,
      headers: authHeader(session.accessToken),
    });
    expect(miss.statusCode).toBe(404);

    const badType = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/wasm`,
      headers: authHeader(session.accessToken),
    });
    expect(badType.statusCode).toBe(400);
  });
});

describe('download & export', () => {
  it('returns 404 while the artifact is not completed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/download`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('serves the storageRef once the artifact is completed', async () => {
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'zod' },
      { $set: { status: 'completed', storageRef: 's3://artifacts/zod.ts' } },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/download`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      artifactType: 'zod',
      version: 1,
      storageRef: 's3://artifacts/zod.ts',
    });
  });

  it('export resolves the export_zip artifact', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/export`,
      headers: authHeader(session.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'export_zip' },
      { $set: { status: 'completed', storageRef: 's3://artifacts/bundle.zip' } },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/export`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().storageRef).toBe('s3://artifacts/bundle.zip');
  });
});

describe('versions', () => {
  it('lists version history in the pagination envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/versions`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect(body.data[0]).toMatchObject({ projectId, version: 1 });
  });

  it('restores a snapshot as a new version', async () => {
    const original = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(session.accessToken),
    });
    const originalValidators = original.json().generationConfig.validators;

    // v1 snapshot exists from generation; editing config moves the project to v2
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(session.accessToken),
      payload: {
        generationConfig: {
          validators: ['yup'],
          types: ['typescript'],
          methods: ['GET'],
          mockRecords: 5,
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/1/restore`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Restore stamps a NEW version whose content matches the v1 snapshot
    expect(body.currentVersion).toBe(3);
    expect(body.ips.version).toBe(3);
    expect(body.generationConfig.validators).toEqual(originalValidators);
    expect(body.generationConfig.validators).not.toEqual(['yup']);

    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/99/restore`,
      headers: authHeader(session.accessToken),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

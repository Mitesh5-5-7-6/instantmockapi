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
import { Artifact, Project } from '@instantmockapi/db';
import { artifactKey, bundleKey, encodeBundle } from '@instantmockapi/storage';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
  testStorage,
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
    // `meta` gained `publishedVersion` and a §18 sync report in Phase 2. The
    // keys stay pinned rather than loosened to `toMatchObject`, so a future
    // addition to this payload is a failing test rather than an unnoticed one.
    expect(Object.keys(body.meta).sort()).toEqual(['publishedVersion', 'sync', 'version']);
    expect(body.meta.version).toBe(1);
    expect(body.meta.publishedVersion).toBeNull();
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

/**
 * §18's warning, at the route.
 *
 * `evaluateSyncState` is unit-tested in `@instantmockapi/shared`; what can only
 * be checked here is the wiring — that the baseline is the project's
 * `publishedVersion`, that the expected set comes from its generation config,
 * and that a pinned version is not given a sync report at all.
 */
describe('the sync report on GET /v1/projects/:id/artifacts', () => {
  const list = (query = '') =>
    app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts${query}`,
      headers: authHeader(session.accessToken),
    });

  it('reports nothing out of sync while nothing has ever been published', async () => {
    // The first generation is still pending, so every artifact is missing —
    // but nothing is being served, so nothing can disagree with it.
    const body = (await list()).json();
    expect(body.meta.sync.outOfSync).toEqual([]);
    expect(body.meta.sync.publishedVersion).toBeNull();
  });

  it('names the artifact a partial regeneration left behind', async () => {
    // v1 generated and published in full...
    await Artifact.updateMany({ projectId, version: 1 }, { $set: { status: 'completed' } });
    await Project.updateOne(
      { _id: projectId },
      { $set: { currentVersion: 2, publishedVersion: 2 } },
    );
    // ...then v2 regenerated the schema and the hosted API, but the user
    // deselected the docs. The OpenAPI on disk now describes v1.
    await Artifact.create([
      { projectId, version: 2, artifactType: 'hosted_api', status: 'completed' },
      { projectId, version: 2, artifactType: 'zod', status: 'completed' },
    ]);

    const body = (await list()).json();
    expect(body.meta.publishedVersion).toBe(2);
    expect(body.meta.sync.outOfSync).toContain('openapi');
    expect(body.meta.sync.outOfSync).not.toContain('zod');
    expect(body.meta.sync.outOfSync).not.toContain('hosted_api');
    // Behind is not the same as absent: every type completed at v1.
    expect(body.meta.sync.missing).toEqual([]);
    const openapi = body.meta.sync.artifacts.find(
      (state: { artifactType: string }) => state.artifactType === 'openapi',
    );
    expect(openapi.generatedVersion).toBe(1);
  });

  it('does not report an artifact the project never asked for', async () => {
    // A project generating no Yup schemas has not lost one.
    await Project.updateOne(
      { _id: projectId },
      { $set: { 'generationConfig.validators': ['zod'] } },
    );
    const body = (await list()).json();
    expect(body.meta.sync.missing).not.toContain('yup');
    expect(
      body.meta.sync.artifacts.map((s: { artifactType: string }) => s.artifactType),
    ).not.toContain('yup');
  });

  it('gives a pinned version no sync report', async () => {
    // Asking for a specific version is asking what that version holds.
    // "Out of sync" is a property of the registry's current state, not of a
    // snapshot, so answering it here would be answering a different question.
    const body = (await list('?version=1')).json();
    expect(body.meta.sync).toBeNull();
    expect(body.meta.version).toBe(1);
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

  it('serves multi-file artifacts as a { files } bundle once completed', async () => {
    const key = bundleKey(projectId, 1, 'zod');
    await testStorage.put(
      key,
      encodeBundle({ 'blogpost.zod.ts': 'export const BlogPostSchema = {};' }),
      'application/json',
    );
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'zod' },
      { $set: { status: 'completed', storageRef: key } },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/download`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      artifactType: 'zod',
      version: 1,
      files: { 'blogpost.zod.ts': 'export const BlogPostSchema = {};' },
    });
  });

  it('returns 404 when the record is completed but the stored object is gone', async () => {
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'zod' },
      { $set: { status: 'completed', storageRef: bundleKey(projectId, 1, 'zod') } },
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/download`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('export streams the raw ZIP with an attachment header', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/export`,
      headers: authHeader(session.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    const key = artifactKey(projectId, 1, 'export_zip', 'export_zip.zip');
    await testStorage.put(key, new TextEncoder().encode('PK-fake-zip'), 'application/zip');
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'export_zip' },
      { $set: { status: 'completed', storageRef: key } },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/export`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="export_zip.zip"');
    expect(res.body).toBe('PK-fake-zip');
  });
});

describe('GET /v1/projects/:id/artifacts/:type/content', () => {
  it('returns a bundle as a { files } map once completed', async () => {
    const key = bundleKey(projectId, 1, 'zod');
    await testStorage.put(
      key,
      encodeBundle({ 'blogpost.zod.ts': 'export const BlogPostSchema = {};' }),
      'application/json',
    );
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'zod' },
      { $set: { status: 'completed', storageRef: key } },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/content`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      artifactType: 'zod',
      version: 1,
      files: { 'blogpost.zod.ts': 'export const BlogPostSchema = {};' },
    });
    // Inline view must NOT force a download
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('returns a single-file artifact as a one-entry files map (no attachment)', async () => {
    const key = artifactKey(projectId, 1, 'openapi', 'openapi.json');
    await testStorage.put(key, new TextEncoder().encode('{"openapi":"3.1.0"}'), 'application/json');
    await Artifact.updateOne(
      { projectId, version: 1, artifactType: 'openapi' },
      { $set: { status: 'completed', storageRef: key } },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/openapi/content`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      artifactType: 'openapi',
      version: 1,
      files: { 'openapi.json': '{"openapi":"3.1.0"}' },
    });
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('rejects binary export_zip with 422 (download-only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/export_zip/content`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 while the artifact is not completed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/artifacts/zod/content`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(404);
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
    // The full generate in beforeEach stamps the version note (doc 03 §7)
    expect(body.data[0]).toMatchObject({ projectId, version: 1, note: 'Full generation' });
  });

  it('stamps a descriptive note per generation and returns it in history', async () => {
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(session.accessToken),
      payload: { artifacts: ['zod'] },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/versions`,
      headers: authHeader(session.accessToken),
    });
    const notesByVersion = new Map<number, string | null>(
      res.json().data.map((v: { version: number; note: string | null }) => [v.version, v.note]),
    );
    expect(notesByVersion.get(1)).toBe('Full generation');
    expect(notesByVersion.get(2)).toBe('Regenerated: zod');
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

    /*
     * Restore SEEDS THE DRAFT (Phase 2 §22). It used to write the live
     * definition and bump `currentVersion` to v3 — which meant the one action
     * most likely to remove fields skipped the review every ordinary edit goes
     * through.
     *
     * So the version does NOT move here. The draft carries the v1 config, the
     * live definition is still v2's, and v3 appears only when the draft is
     * committed after its diff has been seen.
     */
    expect(body.baseVersion).toBe(2);
    expect(body.currentVersion).toBe(2);
    expect(body.rollbackSourceVersion).toBe(1);
    expect(body.generationConfig.validators).toEqual(originalValidators);
    expect(body.generationConfig.validators).not.toEqual(['yup']);
    // And the impact of applying it comes back with it, so the client can go
    // straight to the review screen rather than fetching twice.
    expect(body.analysis).toBeDefined();

    // The live definition is untouched until the commit.
    const live = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(session.accessToken),
    });
    expect(live.json().currentVersion).toBe(2);
    expect(live.json().generationConfig.validators).toEqual(['yup']);

    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/99/restore`,
      headers: authHeader(session.accessToken),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

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
import { Artifact, Project, Version, type IProject } from '@instantmockapi/db';
import type { InternalProjectSchema } from '@instantmockapi/ips';
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
 * Version history: the snapshot gap, the derived status, and the §42 backfill.
 *
 * ## The gap
 *
 * `Version` rows were written in exactly one place — `createGenerationJob` — but
 * `currentVersion` advances in six. So a schema PATCH or a restore left a
 * version number on the project with **no snapshot**:
 *
 *     v1 ✓   v2 ✗(patch)   v3 ✓
 *
 * History showed 1 and 3 with the gap unexplained, and §24's "compare any two
 * versions" could not reach v2 at all.
 */
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
  token = (await login(app, 'owner@example.com')).accessToken;
  projectId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
});

async function reload(): Promise<IProject> {
  const project = await Project.findById(projectId);
  if (!project) {
    throw new Error('project vanished');
  }
  return project;
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: authHeader(token) });
const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: authHeader(token), ...(payload ? { payload } : {}) });
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authHeader(token), payload });

interface VersionRow {
  version: number;
  note: string | null;
  status?: string;
  changeType: string | null;
  parentVersion: number | null;
  rollbackSourceVersion: number | null;
  publishedAt: string | null;
}

async function history(): Promise<VersionRow[]> {
  const response = await get(`/v1/projects/${projectId}/versions`);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { data: VersionRow[] }).data;
}

/** Edit the schema so the definition version advances. */
async function editSchema(): Promise<void> {
  const project = await reload();
  const clone = JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema;
  clone.entities[0]!.description = `edited at ${Date.now()}`;
  const response = await patch(`/v1/projects/${projectId}`, {
    ips: clone as unknown as Record<string, unknown>,
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('every version advance records a snapshot', () => {
  it('records one for a schema edit, which used to leave a gap', async () => {
    // v1 is backfilled on read; the edit makes v2, which had no snapshot before.
    await editSchema();

    const rows = await history();
    expect(rows.map((row) => row.version)).toEqual([2, 1]);
    expect(rows.find((row) => row.version === 2)?.changeType).toBe('FEATURE');
  });

  it('leaves no gap across an edit, a generation and a restore', async () => {
    await editSchema();
    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);
    await editSchema();
    expect((await post(`/v1/projects/${projectId}/versions/2/restore`)).statusCode).toBe(200);

    const project = await reload();
    const rows = await history();

    // Every number from 1 to currentVersion is present — the property §7 and
    // §24 both depend on.
    expect(rows.map((row) => row.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: project.currentVersion }, (_, index) => index + 1),
    );
  });

  it('records where a restored definition came from', async () => {
    await editSchema();
    const restored = await post(`/v1/projects/${projectId}/versions/1/restore`);
    expect(restored.statusCode).toBe(200);

    const rows = await history();
    const newest = rows[0]!;
    // Without this, "v3" and "v3, which is v1's definition" are
    // indistinguishable in the audit trail (§7).
    expect(newest.changeType).toBe('ROLLBACK');
    expect(newest.rollbackSourceVersion).toBe(1);
  });

  it('records the lineage rather than leaving it to arithmetic', async () => {
    await editSchema();
    await editSchema();

    const rows = await history();
    expect(rows.find((row) => row.version === 3)?.parentVersion).toBe(2);
    expect(rows.find((row) => row.version === 2)?.parentVersion).toBe(1);
    // v1 has no parent, and that is a fact rather than a missing value.
    expect(rows.find((row) => row.version === 1)?.parentVersion).toBeNull();
  });

  it('does not record a version for a name-only edit', async () => {
    // Renaming the project is addressing, not definition — it must not burn a
    // version, and `schemaChanged` already gates the bump.
    await patch(`/v1/projects/${projectId}`, { name: 'Renamed' });

    const rows = await history();
    expect(rows.map((row) => row.version)).toEqual([1]);
  });
});

describe('snapshots are immutable', () => {
  it('never overwrites an existing row, however many times a version is recorded', async () => {
    await editSchema();
    const before = await Version.findOne({ version: 2 });
    expect(before).not.toBeNull();

    // A generate at the same version finds the row already there. `$setOnInsert`
    // is what stops it replacing the committed snapshot with a later state of
    // the same definition — which is §4, enforced by the write shape rather than
    // by a guard that could be forgotten.
    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);

    const after = await Version.findOne({ version: 2 });
    expect(after?.createdAt.getTime()).toBe(before!.createdAt.getTime());
    expect(JSON.stringify(after?.ipsSnapshot)).toBe(JSON.stringify(before!.ipsSnapshot));
    expect(after?.note).toBe(before!.note);
  });

  it('keeps one row per version even under a race', async () => {
    // Uniqueness used to be only IMPLIED, by `createGenerationJob` being the
    // single writer. Phase 2 adds writers, so the guarantee moved into the index
    // where concurrency cannot get around it.
    await editSchema();
    await Promise.all([
      post(`/v1/projects/${projectId}/generate`),
      post(`/v1/projects/${projectId}/generate`),
    ]);

    expect(await Version.countDocuments({ projectId, version: 2 })).toBe(1);
  });
});

describe('the §42 backfill', () => {
  it('records a version for a project that predates Phase 2', async () => {
    // The state a pre-Phase-2 project is in: a served version, no snapshot.
    await Version.deleteMany({ projectId });
    expect(await Version.countDocuments({ projectId })).toBe(0);

    const rows = await history();
    expect(rows.map((row) => row.version)).toEqual([1]);
    expect(rows[0]!.changeType).toBe('INITIAL');
  });

  it('is idempotent — a second read inserts nothing', async () => {
    // Lazy and on-read rather than a startup migration, so it must be safe to
    // run on every request. "Do not blindly create duplicate versions."
    await Version.deleteMany({ projectId });

    await history();
    await history();
    await history();

    expect(await Version.countDocuments({ projectId })).toBe(1);
  });

  it('backfills the served version, not the edited one', async () => {
    // A project mid-edit serves v1 while its definition is at v2. The backfill
    // is about giving the LIVE version a readable snapshot; inventing one for a
    // version that was never generated would be fabricating history (§47).
    await editSchema();
    await Version.deleteMany({ projectId });

    const project = await reload();
    expect(project.currentVersion).toBe(2);

    const rows = await history();
    expect(rows.map((row) => row.version)).toEqual([1]);
  });
});

describe('version status is derived', () => {
  it('reports PENDING for a version nothing has been asked of', async () => {
    // A schema edit advanced the definition; no job has run against it.
    await editSchema();

    const rows = await history();
    expect(rows.find((row) => row.version === 2)?.status).toBe('PENDING');
  });

  it('reports PUBLISHED for the version the runtime serves', async () => {
    const project = await reload();
    project.publishedVersion = 1;
    await project.save();

    const rows = await history();
    expect(rows.find((row) => row.version === 1)?.status).toBe('PUBLISHED');
  });

  it('reports GENERATING while artifacts are in flight', async () => {
    await editSchema();
    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);

    // `createGenerationJob` resets the requested artifacts to `pending`.
    const rows = await history();
    expect(rows.find((row) => row.version === 2)?.status).toBe('GENERATING');
  });

  it('reports FAILED when the runtime artifact did not complete', async () => {
    await editSchema();
    await Artifact.create({
      projectId,
      artifactType: 'hosted_api',
      version: 2,
      status: 'failed',
      workerId: null,
      generatedAt: null,
      errorMessage: 'boom',
      storageRef: null,
    });

    const rows = await history();
    expect(rows.find((row) => row.version === 2)?.status).toBe('FAILED');
  });

  it('reports DEGRADED when only an optional artifact failed', async () => {
    // The API will serve; a download is missing. Worth seeing BEFORE publishing,
    // which is why this splits §9's single READY.
    await editSchema();
    await Artifact.create({
      projectId,
      artifactType: 'hosted_api',
      version: 2,
      status: 'completed',
      workerId: 'w1',
      generatedAt: new Date(),
      errorMessage: null,
      storageRef: 'ref',
    });
    await Artifact.create({
      projectId,
      artifactType: 'openapi',
      version: 2,
      status: 'failed',
      workerId: 'w2',
      generatedAt: null,
      errorMessage: 'boom',
      storageRef: null,
    });

    const rows = await history();
    expect(rows.find((row) => row.version === 2)?.status).toBe('DEGRADED');
  });

  it('keeps the live version PUBLISHED even when an artifact has since failed', async () => {
    // The ordering that matters: a live version whose OpenAPI failed a re-run is
    // still the one being served. Letting the artifact rows outrank the pointer
    // would report a running API as FAILED.
    const project = await reload();
    project.publishedVersion = 1;
    await project.save();
    await Artifact.create({
      projectId,
      artifactType: 'hosted_api',
      version: 1,
      status: 'failed',
      workerId: null,
      generatedAt: null,
      errorMessage: 'boom',
      storageRef: null,
    });

    const rows = await history();
    expect(rows.find((row) => row.version === 1)?.status).toBe('PUBLISHED');
  });
});

describe('the project payload names both versions', () => {
  it('exposes publishedVersion and pendingRegeneration', async () => {
    // Only `currentVersion` used to cross the wire, so every screen showing "v4"
    // was naming a version that might not be live.
    const fresh = (await get(`/v1/projects/${projectId}`)).json();
    expect(fresh.publishedVersion).toBeNull();
    expect(fresh.pendingRegeneration).toBe(false);

    const project = await reload();
    project.publishedVersion = 1;
    await project.save();
    await editSchema();

    const edited = (await get(`/v1/projects/${projectId}`)).json();
    expect(edited.currentVersion).toBe(2);
    expect(edited.publishedVersion).toBe(1);
    expect(edited.pendingRegeneration).toBe(true);
  });
});

describe('authorization', () => {
  it('does not let another user read this project’s history', async () => {
    const intruder = (await login(app, 'intruder@example.com')).accessToken;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/versions`,
      headers: authHeader(intruder),
    });
    // NOT_FOUND rather than 403, so existence is not leaked (§40).
    expect(response.statusCode).toBe(404);
  });
});

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
import { Artifact, Job, Project, Version, type IProject } from '@instantmockapi/db';
import type { ArtifactType } from '@instantmockapi/shared';
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
 * Explicit publish (Phase 2 §1–§3, §10, §11).
 *
 * The boundary this file defends:
 *
 *     Draft ─▶ Generate ─▶ READY ──(explicit publish)──▶ Live
 *
 * Generation does not publish. A single exception exists — a project with
 * nothing live auto-publishes so onboarding ends on a working URL — and it is
 * keyed on `hosted.url`, not on `publishedVersion`, because
 * `pinPublishedVersion` stamps the latter speculatively on the first edit.
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

const publish = (version: number) => post(`/v1/projects/${projectId}/versions/${version}/publish`);

/** Edit the schema so the definition version advances. */
async function editSchema(): Promise<void> {
  const project = await reload();
  const clone = JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema;
  clone.entities[0]!.description = `edited at ${Date.now()}-${Math.random()}`;
  const response = await patch(`/v1/projects/${projectId}`, {
    ips: clone as unknown as Record<string, unknown>,
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Mark one artifact at a version, as a settled generation would. */
async function artifact(
  version: number,
  artifactType: ArtifactType,
  status: 'pending' | 'generating' | 'completed' | 'failed' = 'completed',
): Promise<void> {
  await Artifact.findOneAndUpdate(
    { projectId, artifactType, version },
    {
      $set: {
        status,
        workerId: status === 'completed' ? 'w1' : null,
        generatedAt: status === 'completed' ? new Date() : null,
        errorMessage: status === 'failed' ? 'boom' : null,
        storageRef: status === 'completed' ? `ref/${artifactType}` : null,
      },
    },
    { upsert: true },
  );
}

/**
 * Put the project in the state a successful publish leaves it in.
 *
 * The `Version` row has to be created here rather than assumed:
 * `POST /projects` writes no snapshot — a brand-new project's v1 row appears
 * only when it generates or when the §13 backfill runs — so a bare
 * `updateOne` to stamp `publishedAt` would silently match nothing and three
 * assertions downstream would be reading `null`.
 */
async function goLive(version: number): Promise<void> {
  await artifact(version, 'hosted_api');
  const project = await reload();

  await Version.findOneAndUpdate(
    { projectId, version },
    {
      $setOnInsert: {
        ipsSnapshot: project.ips,
        configSnapshot: project.generationConfig,
        note: 'Generated',
        changeType: 'FEATURE',
      },
      $set: { publishedAt: new Date() },
    },
    { upsert: true },
  );

  project.publishedVersion = version;
  project.status = 'active';
  project.hosted = {
    url: 'https://example.test/p/abc/shop',
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  await project.save();
}

/** A READY version: definition advanced, runtime artifact completed, nothing in flight. */
async function makeReady(): Promise<number> {
  await editSchema();
  const version = (await reload()).currentVersion;
  await artifact(version, 'hosted_api');
  await Job.deleteMany({ projectId });
  return version;
}

describe('a READY version can be published', () => {
  it('moves the live pointer and returns the hosted URL', async () => {
    await goLive(1);
    const ready = await makeReady();

    const response = await publish(ready);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.published).toBe(true);
    expect(body.version).toBe(ready);
    expect(body.publishedVersion).toBe(ready);
    expect(body.hosted.url).toContain('/p/');

    expect((await reload()).publishedVersion).toBe(ready);
  });

  it('records the publish event, which nothing else does', async () => {
    // "Was live and is not any more" leaves no trace in the artifact rows, so
    // the history list and the derived SUPERSEDED status both need this.
    await goLive(1);
    const ready = await makeReady();
    await publish(ready);

    const row = await Version.findOne({ projectId, version: ready });
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  it('surfaces a degraded publish rather than hiding it', async () => {
    // A failed OpenAPI degrades a version; it does not block it. The response
    // says so at the moment of the decision.
    await goLive(1);
    const ready = await makeReady();
    await artifact(ready, 'openapi', 'failed');

    const body = (await publish(ready)).json();
    expect(body.published).toBe(true);
    expect(body.degraded).toEqual(['openapi']);
  });

  it('reports the stale-data risk when mock data was not reseeded', async () => {
    // `MockStore` is not version-keyed, so the records on disk may be shaped for
    // the previous schema. Degraded, not down — but not silently either.
    await goLive(1);
    const ready = await makeReady();
    await artifact(ready, 'mock_data', 'failed');

    expect((await publish(ready)).json().staleDataRisk).toBe(true);
  });

  it('makes an inactive project active, so publish can revive an expired one', async () => {
    const ready = await makeReady();
    const project = await reload();
    project.status = 'draft';
    await project.save();

    await publish(ready);
    expect((await reload()).status).toBe('active');
  });
});

describe('a version that is not READY cannot be published', () => {
  it('refuses a version with no artifacts at all', async () => {
    // PENDING: the definition advanced and nothing was ever asked of it.
    await goLive(1);
    await editSchema();
    const pending = (await reload()).currentVersion;

    const response = await publish(pending);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VERSION_NOT_READY');
    expect((await reload()).publishedVersion).toBe(1);
  });

  it('names the blocking artifacts, so the UI can offer to retry them', async () => {
    // Its own error code rather than a bare CONFLICT precisely so the client can
    // do something specific — matching on message text is what this avoids.
    await goLive(1);
    await editSchema();
    const version = (await reload()).currentVersion;
    await artifact(version, 'openapi', 'completed');

    const response = await publish(version);
    expect(response.json().error.details).toEqual([
      {
        path: 'artifacts.hosted_api',
        issue: 'must be generated successfully before this version can be published',
      },
    ]);
  });

  it('refuses a version whose runtime artifact failed', async () => {
    await goLive(1);
    await editSchema();
    const version = (await reload()).currentVersion;
    await artifact(version, 'hosted_api', 'failed');

    expect((await publish(version)).json().error.code).toBe('VERSION_NOT_READY');
  });

  it('refuses a version that is still generating', async () => {
    // §27: never publish a generating version. The job document is the fence;
    // the readiness check behind it is the backstop.
    await goLive(1);
    await editSchema();
    const version = (await reload()).currentVersion;
    await artifact(version, 'hosted_api');
    await Job.create({
      projectId,
      version,
      type: 'full',
      requestedArtifacts: ['hosted_api'],
      idempotencyKey: `key-${version}`,
      status: 'running',
      workers: [],
    });

    const response = await publish(version);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(response.json().error.message).toContain('still generating');
  });

  it('refuses a version that was never authored', async () => {
    await goLive(1);
    const response = await publish(99);
    expect(response.statusCode).toBe(404);
  });
});

describe('publishing backwards', () => {
  it('is refused, because that is a rollback', async () => {
    // §16: a rollback creates a NEW version through the normal pipeline rather
    // than re-pointing at an old one.
    const older = await makeReady();
    await artifact(older, 'hosted_api');
    await goLive(older);

    const newer = await makeReady();
    await publish(newer);

    const response = await publish(older);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Restore it');
    expect((await reload()).publishedVersion).toBe(newer);
  });
});

describe('re-publishing the live version', () => {
  it('is a no-op success rather than an error', async () => {
    // The UI hides Publish on the live version, so a request here is a stale tab
    // or a double-click. A red toast for "it is already live" is worse than
    // nothing.
    await goLive(1);
    const response = await publish(1);

    expect(response.statusCode).toBe(200);
    expect(response.json().published).toBe(false);
    expect(response.json().reason).toBe('already-published');
  });

  it('does not refresh the expiry, so Publish is not a free renewal button', async () => {
    await goLive(1);
    const before = (await reload()).hosted.expiresAt;

    await publish(1);

    expect((await reload()).hosted.expiresAt?.getTime()).toBe(before?.getTime());
  });
});

describe('editing and generating never change the live version', () => {
  it('leaves the live version alone across an edit', async () => {
    // §10. The draft is the editing surface; the published version is the
    // runtime authority.
    await goLive(1);
    await editSchema();

    const project = await reload();
    expect(project.currentVersion).toBe(2);
    expect(project.publishedVersion).toBe(1);
    expect(project.hosted.url).not.toBeNull();
  });

  it('leaves the live version alone across a generation request', async () => {
    await goLive(1);
    await editSchema();
    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);

    expect((await reload()).publishedVersion).toBe(1);
  });

  it('only publish moves it', async () => {
    await goLive(1);
    const ready = await makeReady();
    expect((await reload()).publishedVersion).toBe(1);

    await publish(ready);
    expect((await reload()).publishedVersion).toBe(ready);
  });
});

describe('generating never takes the live API off the air', () => {
  /**
   * The second live pointer, which the `publishedVersion` split left open.
   *
   * `mock-runtime/src/hosting.ts` 404s unless `status === 'active'`, and
   * `createGenerationJob` used to set `'generating'` unconditionally — so every
   * regenerate of a live project blanked the hosted URL for the whole job, with
   * no edit involved. §27's outage, inverted.
   */
  it('keeps a live project active while it generates', async () => {
    await goLive(1);
    await editSchema();

    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);

    const project = await reload();
    expect(project.status).toBe('active');
    expect(project.hosted.url).not.toBeNull();
  });

  it('still marks a project with nothing live as generating', async () => {
    // The status is not being abandoned — it is being made to mean one thing.
    // A project with nothing to serve has no live API to protect, and the
    // wizard reads this to show its progress screen.
    expect((await post(`/v1/projects/${projectId}/generate`)).statusCode).toBe(202);
    expect((await reload()).status).toBe('generating');
  });
});

describe('a failed version never becomes live', () => {
  it('keeps the previous version live and refuses the publish', async () => {
    // §11. The invariant that outranks everything: a failed generation can never
    // destroy or temporarily disable the currently live version.
    await goLive(1);
    await editSchema();
    const failed = (await reload()).currentVersion;
    await artifact(failed, 'hosted_api', 'failed');
    await artifact(failed, 'openapi', 'failed');

    expect((await publish(failed)).statusCode).toBe(409);

    const project = await reload();
    expect(project.publishedVersion).toBe(1);
    expect(project.hosted.url).not.toBeNull();
  });

  it('leaves the previous published version’s snapshot and artifacts intact', async () => {
    await goLive(1);
    const before = await Version.findOne({ projectId, version: 1 });
    await editSchema();
    const failed = (await reload()).currentVersion;
    await artifact(failed, 'hosted_api', 'failed');
    await publish(failed);

    const after = await Version.findOne({ projectId, version: 1 });
    expect(JSON.stringify(after?.ipsSnapshot)).toBe(JSON.stringify(before!.ipsSnapshot));
    const liveArtifact = await Artifact.findOne({
      projectId,
      version: 1,
      artifactType: 'hosted_api',
    });
    expect(liveArtifact?.status).toBe('completed');
  });
});

describe('the previous published version is preserved', () => {
  it('stays readable and keeps its own artifacts after a newer one goes live', async () => {
    // §3: never delete the previous published version, never mutate its
    // snapshot.
    await goLive(1);
    const v1Snapshot = JSON.stringify(
      (await Version.findOne({ projectId, version: 1 }))!.ipsSnapshot,
    );

    const ready = await makeReady();
    await publish(ready);

    const v1 = await Version.findOne({ projectId, version: 1 });
    expect(v1).not.toBeNull();
    expect(JSON.stringify(v1!.ipsSnapshot)).toBe(v1Snapshot);
    expect(await Artifact.countDocuments({ projectId, version: 1 })).toBeGreaterThan(0);
  });

  it('reports the superseded version as SUPERSEDED, not READY', async () => {
    // READY would imply an action is available; re-publishing it is a rollback.
    await goLive(1);
    const ready = await makeReady();
    await publish(ready);

    const rows = (await get(`/v1/projects/${projectId}/versions`)).json().data as {
      version: number;
      status: string;
    }[];
    expect(rows.find((row) => row.version === 1)?.status).toBe('SUPERSEDED');
    expect(rows.find((row) => row.version === ready)?.status).toBe('PUBLISHED');
  });
});

describe('backward compatibility', () => {
  it('recognises the live version of a project that has no Version row', async () => {
    // §13. A project's ability to publish must never depend on UI browsing
    // order — the backfill runs on the publish path too, not only on the
    // history read. Without it this request would 404 on "the version was never
    // authored" for the version that is actually serving traffic.
    await goLive(1);
    await Version.deleteMany({ projectId });
    expect(await Version.countDocuments({ projectId })).toBe(0);

    const response = await publish(1);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().reason).toBe('already-published');
    expect(await Version.countDocuments({ projectId, version: 1 })).toBe(1);
  });

  it('still refuses a version that genuinely was never authored', async () => {
    // The backfill records the LIVE version, and only that one. It must not
    // become a way to publish a number nothing ever generated.
    await goLive(1);
    await Version.deleteMany({ projectId });

    expect((await publish(7)).statusCode).toBe(404);
  });
});

describe('authorization', () => {
  it('does not let another user publish this project', async () => {
    await goLive(1);
    const ready = await makeReady();
    const intruder = (await login(app, 'intruder@example.com')).accessToken;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/${ready}/publish`,
      headers: authHeader(intruder),
    });

    // NOT_FOUND rather than 403, so existence is not leaked (§40).
    expect(response.statusCode).toBe(404);
    expect((await reload()).publishedVersion).toBe(1);
  });
});

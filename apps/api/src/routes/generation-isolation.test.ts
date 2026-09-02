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
import {
  Artifact,
  Project,
  mustAdvanceBeforeGenerating,
  publishedVersionOf,
} from '@instantmockapi/db';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
} from '../testing/harness.js';
import { createGenerationJob } from '../generation-service.js';

/**
 * Regeneration isolation — the fourth and last of the deployment-boundary
 * outages.
 *
 * `createOrResetArtifactRecord` sets an artifact row to
 * `status: 'pending', storageRef: null` before any work begins. The hosted
 * runtime requires `completed` plus a `storageRef`. A full `generate` wrote into
 * `project.currentVersion` — the very version being served — so **every ordinary
 * regenerate 404ed the live URL for the whole duration of the job**, with no
 * editing involved at all. A `failed_partial` left it 404ing indefinitely.
 *
 * The invariant:
 *
 *     v2 = LIVE  ──────────────── keeps serving throughout
 *     v3 = GENERATING  ─── schema, validation, mock data, hosted_api…
 *     v3 = LIVE  ───────────────── promoted only once hosted_api completed
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
  const created = await createProjectViaApi(app, token, 'Shop');
  projectId = created.json().id as string;
});

async function reload() {
  const project = await Project.findById(projectId);
  if (!project) {
    throw new Error('project vanished');
  }
  return project;
}

/** Put the project in the state a successful publish leaves it in. */
async function publishAt(version: number): Promise<void> {
  await Artifact.create({
    projectId,
    artifactType: 'hosted_api',
    version,
    status: 'completed',
    storageRef: `s3://bucket/${projectId}/v${version}/hosting.config.json`,
    generatedAt: new Date(),
    workerId: 'F',
  });
  await Project.updateOne(
    { _id: projectId },
    { $set: { currentVersion: version, publishedVersion: version, status: 'active' } },
  );
}

function generate() {
  return app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/generate`,
    headers: authHeader(token),
  });
}

/** The row the hosted runtime actually resolves. */
function liveArtifact(version: number) {
  return Artifact.findOne({ projectId, artifactType: 'hosted_api', version });
}

describe('mustAdvanceBeforeGenerating', () => {
  it('is false for a project that has never published', async () => {
    // A brand-new project must generate INTO v1, or v1 becomes a phantom that
    // never had artifacts and never will.
    expect(mustAdvanceBeforeGenerating(await reload())).toBe(false);
  });

  it('is true when the current version is the one being served', async () => {
    await publishAt(1);
    expect(mustAdvanceBeforeGenerating(await reload())).toBe(true);
  });

  it('is false when the definition is already ahead of what is served', async () => {
    // After an edit, v2 has never been served, so generation belongs there.
    // Advancing again would generate artifacts for a definition nobody authored.
    await publishAt(1);
    await Project.updateOne({ _id: projectId }, { $set: { currentVersion: 2 } });
    expect(mustAdvanceBeforeGenerating(await reload())).toBe(false);
  });
});

describe('POST /v1/projects/:id/generate on a live project', () => {
  /**
   * THE regression test for outage #4.
   *
   * Before the fix this route reset the v1 `hosted_api` row to `pending` with a
   * null `storageRef`, which is precisely the state the runtime treats as "not
   * found". Every regenerate was an outage.
   */
  it('leaves the live artifact completed and its storageRef intact', async () => {
    await publishAt(1);
    const before = await liveArtifact(1);
    expect(before?.status).toBe('completed');

    expect((await generate()).statusCode).toBe(202);

    const after = await liveArtifact(1);
    expect(after?.status).toBe('completed');
    expect(after?.storageRef).toBe(before?.storageRef);
  });

  it('advances the definition and generates into the new version', async () => {
    await publishAt(1);
    expect((await generate()).statusCode).toBe(202);

    const project = await reload();
    expect(project.currentVersion).toBe(2);
    // The pending rows the job will fill are at v2, not over v1.
    expect(await liveArtifact(2)).not.toBeNull();
    expect((await liveArtifact(2))?.status).toBe('pending');
  });

  it('keeps the runtime pointed at the old version while the job runs', async () => {
    await publishAt(1);
    await generate();

    // This is what the mock runtime reads. Until the worker promotes, it stays
    // on the version whose artifacts are complete.
    expect(publishedVersionOf(await reload())).toBe(1);
  });

  it('mirrors the new version into ips.version, which reaches artifact content', async () => {
    // `ips.version` becomes the OpenAPI `info.version`, the Postman collection
    // name and the export README, so it has to travel with the target rather
    // than lag a version behind it.
    await publishAt(1);
    await generate();

    const project = await reload();
    expect((project.ips as { version: number }).version).toBe(2);
  });

  it('does not advance again when the definition is already ahead', async () => {
    // A draft committed at v2 then generated should produce v2 — not v3, which
    // would be artifacts for a definition that was never authored.
    await publishAt(1);
    await Project.updateOne({ _id: projectId }, { $set: { currentVersion: 2 } });

    await generate();

    expect((await reload()).currentVersion).toBe(2);
  });
});

describe('POST /v1/projects/:id/generate on a project that has never published', () => {
  it('generates into v1 rather than skipping it', async () => {
    // The reason the advance is conditional. Bumping unconditionally would leave
    // v1 with no artifacts, forever.
    expect((await generate()).statusCode).toBe(202);

    const project = await reload();
    expect(project.currentVersion).toBe(1);
    expect(await liveArtifact(1)).not.toBeNull();
  });

  it('resets in place, which is safe because nothing is serving', async () => {
    // Two generates before anything publishes both write v1. No outage is
    // possible: `publishedVersion` is still null, so the runtime resolves
    // nothing either way.
    await generate();
    await Artifact.updateOne(
      { projectId, artifactType: 'hosted_api', version: 1 },
      { $set: { status: 'completed', storageRef: 's3://x' } },
    );

    // Same version, same config, same artifacts, same schema — so this dedupes
    // into the running job rather than starting a second one.
    const second = await generate();
    expect(second.statusCode).toBe(202);
    expect((await reload()).currentVersion).toBe(1);
  });
});

describe('the guard in createGenerationJob', () => {
  /**
   * Belt and braces, and it earns its place.
   *
   * The routes make generating into the live version unreachable, so this can
   * only fire if a caller bypasses them. Verified by disabling the conditional
   * advance in the route: the request then returns **500** rather than silently
   * resetting the live artifact to `pending`. A loud failure is strictly better
   * than a 404 nobody can explain.
   *
   * Called directly rather than through a route, because no route can produce
   * the forbidden state any more — which is the point.
   */
  it('refuses to generate into the version being served', async () => {
    await publishAt(3);
    const project = await reload();
    expect(publishedVersionOf(project)).toBe(3);

    // currentVersion === publishedVersion, and no advance. This is the state the
    // old full-generate route walked straight into on every regenerate.
    await expect(
      createGenerationJob({
        project,
        type: 'full',
        requestedArtifacts: ['hosted_api'],
        generationConfig: project.generationConfig,
        plan: 'free',
      }),
    ).rejects.toThrow(/currently serving traffic/i);
  });

  it('leaves the live artifact untouched when it refuses', async () => {
    // The whole reason to fail loudly: refusing must not itself have already
    // reset the row it is protecting.
    await publishAt(3);
    const project = await reload();

    await expect(
      createGenerationJob({
        project,
        type: 'full',
        requestedArtifacts: ['hosted_api'],
        generationConfig: project.generationConfig,
        plan: 'free',
      }),
    ).rejects.toThrow();

    const live = await liveArtifact(3);
    expect(live?.status).toBe('completed');
    expect(live?.storageRef).toBeTruthy();
  });

  it('allows generating into any version that is not live', async () => {
    await publishAt(3);
    await Project.updateOne({ _id: projectId }, { $set: { currentVersion: 4 } });

    const job = await createGenerationJob({
      project: await reload(),
      type: 'full',
      requestedArtifacts: ['hosted_api'],
      generationConfig: (await reload()).generationConfig,
      plan: 'free',
    });

    expect(job.jobId).toEqual(expect.any(String));
    expect(publishedVersionOf(await reload())).toBe(3);
  });
});

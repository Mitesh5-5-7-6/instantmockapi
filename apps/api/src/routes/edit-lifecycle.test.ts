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
  Version,
  hasPendingRegeneration,
  publishedVersionOf,
  versionArtifactOutcomes,
  type IProject,
} from '@instantmockapi/db';
import { evaluatePromotion, evaluateRuntimeReadiness } from '@instantmockapi/shared';
import { artifactKey } from '@instantmockapi/storage';
import { ensureSchemaIds, materializeRelations } from '@instantmockapi/ips';
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
 * The Phase 1 finish line, end to end.
 *
 *     v1 LIVE ──▶ edit ──▶ draft ──▶ diff ──▶ impact ──▶ commit
 *        │                                                 │
 *        │                                            v2 PENDING
 *        │                                                 │
 *        └──── STILL SERVING throughout ─────────▶ generate ──▶ ready ──▶ promote
 *                                                                            │
 *                                                                       v2 LIVE
 *
 * The two claims being proved, which the earlier outage broke both of:
 *
 *  1. Editing and committing a definition never moves the version the hosted
 *     runtime resolves. The live API keeps answering from its own artifacts
 *     until a generation has actually produced replacements.
 *  2. Promotion is gated on runtime readiness, not on the commit having happened.
 *
 * Generation itself is not run here — the workers are a separate process, and
 * `enqueueGenerationJob` is mocked repo-wide in the API suite. What IS exercised
 * is the real decision function the worker calls (`evaluatePromotion` over
 * `versionArtifactOutcomes`), so the gate is tested rather than restated.
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
  await seedUserDefinition();
});

/**
 * Replace the parsed fixture with a flat `User` entity.
 *
 * The shared fixture parses `{ customer: { … } }` into `MainEntity { id, customer:
 * object }`, which would make every assertion below read about a nested object
 * rather than the case this test is about. Written straight to the document so
 * `currentVersion` stays at 1 — going through `PATCH /projects/:id` would bump it
 * and the version narrative would start at v2.
 */
async function seedUserDefinition(): Promise<void> {
  const project = await reload();
  const ips = materializeRelations({
    projectId,
    version: 1,
    entities: [
      {
        name: 'User',
        identity: { field: 'id', style: 'uuid' },
        fields: [
          {
            name: 'name',
            type: 'string',
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
          {
            name: 'email',
            type: 'string',
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
          {
            name: 'age',
            type: 'integer',
            required: false,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
        ],
      },
    ],
    generationConfig: project.generationConfig,
  } as never);
  ensureSchemaIds(ips);
  project.ips = ips;
  project.markModified('ips');
  await project.save();
}

async function reload(): Promise<IProject> {
  const project = await Project.findById(projectId);
  if (!project) {
    throw new Error('project vanished');
  }
  return project;
}

/** Mark every artifact of a version completed, as a successful worker run would. */
async function completeAllArtifacts(version: number): Promise<void> {
  const records = await Artifact.find({ projectId, version });
  for (const record of records) {
    record.status = 'completed';
    record.storageRef = artifactKey(projectId, version, record.artifactType);
    await record.save();
  }
}

/** Run the promotion decision exactly as the worker's `settleJob` does. */
async function promoteIfReady(version: number): Promise<{ promoted: boolean; reason: string }> {
  const project = await reload();
  const outcomes = await versionArtifactOutcomes(project._id, version);
  const decision = evaluatePromotion({
    candidate: version,
    published: project.publishedVersion,
    outcomes,
  });
  if (decision.promote) {
    project.publishedVersion = version;
    await project.save();
  }
  return { promoted: decision.promote, reason: decision.reason };
}

/** Put the project in the state a generated, serving project is in. */
async function goLive(): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/generate`,
    headers: authHeader(token),
  });
  expect(res.statusCode).toBe(202);
  await completeAllArtifacts(1);
  const { promoted } = await promoteIfReady(1);
  expect(promoted).toBe(true);
}

/** The user's edit: change the type of a field. */
function retypeField(
  ips: Record<string, unknown>,
  fieldName: string,
  type: string,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(ips)) as {
    entities: { fields: { name: string; type: string }[] }[];
  };
  const target = clone.entities[0]?.fields.find((f) => f.name === fieldName);
  if (!target) {
    throw new Error(`fixture has no field ${fieldName}`);
  }
  target.type = type;
  return clone as unknown as Record<string, unknown>;
}

/** The digest a risky commit must echo back. */
async function currentDigest(): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `${draftUrl()}/impact`,
    headers: authHeader(token),
  });
  return (res.json() as { digest: string }).digest;
}

const draftUrl = () => `/v1/projects/${projectId}/draft`;

// ---------------------------------------------------------------------------

describe('the full edit lifecycle', () => {
  it('carries a type change from v1 LIVE to v2 LIVE without an outage', async () => {
    // ── v1 LIVE ──
    await goLive();
    let project = await reload();
    expect(project.currentVersion).toBe(1);
    expect(publishedVersionOf(project)).toBe(1);
    expect(hasPendingRegeneration(project)).toBe(false);

    // ── fork a draft ──
    const forked = await app.inject({
      method: 'POST',
      url: draftUrl(),
      headers: authHeader(token),
    });
    expect(forked.statusCode).toBe(201);
    expect(forked.json()).toMatchObject({ baseVersion: 1, stale: false });

    // ── edit: email string → integer ──
    const edited = await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: { ips: retypeField(project.ips, 'email', 'integer') },
    });
    expect(edited.statusCode).toBe(200);

    // Editing a draft touches neither version. This is the whole point of the
    // draft existing.
    project = await reload();
    expect(project.currentVersion).toBe(1);
    expect(publishedVersionOf(project)).toBe(1);

    // ── impact: the review-changes panel ──
    const impact = await app.inject({
      method: 'GET',
      url: `${draftUrl()}/impact`,
      headers: authHeader(token),
    });
    expect(impact.statusCode).toBe(200);
    const analysis = impact.json() as {
      risk: string;
      requiresAcknowledgement: boolean;
      affected: { method: string; path: string; reasons: { reason: string }[] }[];
      unaffected: { method: string; path: string }[];
    };

    expect(analysis.risk).toBe('BREAKING');
    expect(analysis.requiresAcknowledgement).toBe(true);

    // The requirement: DELETE is spared, and said to be spared.
    const affected = analysis.affected.map((e) => `${e.method} ${e.path}`).sort();
    const unaffected = analysis.unaffected.map((e) => `${e.method} ${e.path}`).sort();
    expect(affected).toContain('PATCH /user/{id}');
    expect(affected).not.toContain('DELETE /user/{id}');
    expect(unaffected).toContain('DELETE /user/{id}');

    // And the reason a UI renders under it.
    const patchReasons = analysis.affected
      .find((e) => e.method === 'PATCH')!
      .reasons.map((r) => r.reason);
    expect(patchReasons).toContain('request.body.email');

    // ── commit ──
    const committed = await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: await currentDigest() },
    });
    expect(committed.statusCode).toBe(202);
    expect(committed.json()).toMatchObject({
      committed: true,
      version: 2,
      // The assertion this whole phase exists for.
      publishedVersion: 1,
    });

    // ── v2 PENDING, v1 STILL LIVE ──
    project = await reload();
    expect(project.currentVersion).toBe(2);
    expect(publishedVersionOf(project)).toBe(1);
    expect(hasPendingRegeneration(project)).toBe(true);

    // The committed definition is what the new version snapshots.
    const snapshot = await Version.findOne({ projectId, version: 2 });
    expect(snapshot).not.toBeNull();
    const snapshotIps = snapshot!.ipsSnapshot as {
      entities: { fields: { name: string; type: string }[] }[];
    };
    expect(snapshotIps.entities[0]!.fields.find((f) => f.name === 'email')!.type).toBe('integer');
    // v1's snapshot is untouched, so the previous definition is still readable.
    const previous = await Version.findOne({ projectId, version: 1 });
    const previousIps = previous!.ipsSnapshot as {
      entities: { fields: { name: string; type: string }[] }[];
    };
    expect(previousIps.entities[0]!.fields.find((f) => f.name === 'email')!.type).toBe('string');

    // ── before generation finishes, promotion must refuse ──
    const early = await promoteIfReady(2);
    expect(early.promoted).toBe(false);
    project = await reload();
    expect(publishedVersionOf(project)).toBe(1);

    // ── generation completes ──
    await completeAllArtifacts(2);

    // ── promote ──
    const promotion = await promoteIfReady(2);
    expect(promotion.promoted).toBe(true);

    // ── v2 LIVE ──
    project = await reload();
    expect(publishedVersionOf(project)).toBe(2);
    expect(hasPendingRegeneration(project)).toBe(false);

    // v1 remains available for comparison, which is what Phase 2's diff view
    // will read.
    expect(await Version.findOne({ projectId, version: 1 })).not.toBeNull();
    const v1Artifacts = await Artifact.find({ projectId, version: 1, artifactType: 'hosted_api' });
    expect(v1Artifacts).toHaveLength(1);
    expect(v1Artifacts[0]!.status).toBe('completed');

    // The draft is gone — it became the definition.
    const gone = await app.inject({ method: 'GET', url: draftUrl(), headers: authHeader(token) });
    expect(gone.statusCode).toBe(404);
  });

  /**
   * The failure mode the promotion gate exists for: a broken documentation
   * generator must not take a working mock API down, and must not silently
   * promote either. `hosted_api` is the runtime gate; OpenAPI is not.
   */
  it('still promotes when a non-runtime artifact fails', async () => {
    await goLive();

    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'string') },
    });
    await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: await currentDigest() },
    });

    await completeAllArtifacts(2);
    await Artifact.updateOne(
      { projectId, version: 2, artifactType: 'openapi' },
      { $set: { status: 'failed', storageRef: null } },
    );

    const outcomes = await versionArtifactOutcomes((await reload())._id, 2);
    const readiness = evaluateRuntimeReadiness(outcomes);
    expect(readiness.ready).toBe(true);
    expect(readiness.degraded).toContain('openapi');

    const { promoted } = await promoteIfReady(2);
    expect(promoted).toBe(true);
    expect(publishedVersionOf(await reload())).toBe(2);
  });

  it('refuses to promote when the runtime artifact itself failed', async () => {
    await goLive();

    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'string') },
    });
    await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: await currentDigest() },
    });

    await completeAllArtifacts(2);
    await Artifact.updateOne(
      { projectId, version: 2, artifactType: 'hosted_api' },
      { $set: { status: 'failed', storageRef: null } },
    );

    const { promoted } = await promoteIfReady(2);
    expect(promoted).toBe(false);
    // v1 keeps serving. A failed generation can never disable the live version.
    expect(publishedVersionOf(await reload())).toBe(1);
  });
});

describe('switching an entity from UUIDs to counting numbers', () => {
  /**
   * A real user's first edit, and it failed twice.
   *
   * 1. The impact report named `ips` among the artifacts to regenerate. The web
   *    panel echoed the list back to commit, whose schema validates against
   *    `REGENERATABLE_ARTIFACTS` — which excludes `ips` because the API owns it.
   *    Every commit from the editor answered 400.
   * 2. `materializeRelations` only ever *added* a missing identity field, so
   *    changing `identity.style` left the stored `id` field typed `uuid`. Mock
   *    data would have seeded `1, 2, 3` into a runtime validating UUIDs.
   *
   * This walks the whole thing through the real routes.
   */
  it('commits cleanly and retypes the identity field', async () => {
    await goLive();

    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });

    const project = await reload();
    const clone = JSON.parse(JSON.stringify(project.ips)) as {
      entities: { identity: { field: string; style: string } }[];
    };
    expect(clone.entities[0]!.identity.style).toBe('uuid');
    clone.entities[0]!.identity.style = 'int';

    const saved = await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: { ips: clone as unknown as Record<string, unknown> },
    });
    expect(saved.statusCode).toBe(200);

    const analysis = (
      await app.inject({
        method: 'GET',
        url: `${draftUrl()}/impact`,
        headers: authHeader(token),
      })
    ).json() as { artifacts: string[]; digest: string; changes: { kind: string }[] };

    // `ips` must not be offered — no client may request it.
    expect(analysis.artifacts).not.toContain('ips');
    // The retype is reported, not silent: the user confirms it.
    expect(analysis.changes.map((c) => c.kind)).toContain('FIELD_TYPE_CHANGED');

    // The exact round trip the editor performs.
    const committed = await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: analysis.digest, artifacts: analysis.artifacts },
    });
    expect(committed.statusCode, JSON.stringify(committed.json())).toBe(202);

    const after = await reload();
    const entity = (
      after.ips as {
        entities: { identity: { style: string }; fields: { name: string; type: string }[] }[];
      }
    ).entities[0]!;
    expect(entity.identity.style).toBe('int');
    // The invariant: the descriptor and the field agree.
    expect(entity.fields.find((f) => f.name === 'id')?.type).toBe('integer');
    // And the live runtime is still on v1 throughout.
    expect(publishedVersionOf(after)).toBe(1);
  });
});

describe('a project from before the published/current split', () => {
  /**
   * The ordering trap, and the one case that can still expose it.
   *
   * A project generated before `publishedVersion` existed has it null, with real
   * artifacts sitting at `currentVersion`. `publishedVersionOf` falls back to
   * `currentVersion` — and a fallback FOLLOWS the field it falls back to. So a
   * commit that bumps the definition before pinning captures the bumped value,
   * and the live URL immediately resolves a version with no artifacts.
   *
   * Every other test here calls `goLive()`, which sets `publishedVersion`
   * explicitly and makes `pinPublishedVersion` a no-op whatever the order. This
   * one deliberately does not, so the ordering is actually under test.
   */
  it('legacy project pins published runtime before currentVersion advances', async () => {
    // Generated and complete, but never promoted — exactly a pre-split document.
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/generate`,
      headers: authHeader(token),
    });
    await completeAllArtifacts(1);

    let project = await reload();
    expect(project.publishedVersion ?? null).toBeNull();
    // The runtime is nevertheless serving v1, via the fallback.
    expect(publishedVersionOf(project)).toBe(1);

    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: { ips: retypeField(project.ips, 'email', 'integer') },
    });
    const committed = await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: await currentDigest() },
    });
    expect(committed.statusCode).toBe(202);

    project = await reload();
    expect(project.currentVersion).toBe(2);
    // THE ORDERING IS SACRED. Pinned to what was ACTUALLY being served, not
    // dragged along by the bump. If this reads 2, the hosted URL is resolving
    // artifacts that do not exist and every caller gets a 404.
    expect(
      project.publishedVersion,
      'pinPublishedVersion must run BEFORE currentVersion += 1',
    ).toBe(1);
    expect(publishedVersionOf(project)).toBe(1);
    expect(hasPendingRegeneration(project)).toBe(true);
  });
});

describe('a stale draft', () => {
  /**
   * The rule the commit API enforces rather than papering over. The user
   * reasoned about a diff against v1; if the definition has moved to v2 since,
   * that diff described a definition that no longer exists. Merging silently
   * would apply an edit nobody reviewed.
   */
  it('is rejected at commit with the two versions named', async () => {
    await goLive();

    const forked = await app.inject({
      method: 'POST',
      url: draftUrl(),
      headers: authHeader(token),
    });
    expect(forked.json().baseVersion).toBe(1);

    // The definition moves underneath the open draft — another tab, a restore.
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'number') },
    });
    expect((await reload()).currentVersion).toBe(2);

    const rejected = await app.inject({
      method: 'POST',
      url: `${draftUrl()}/commit`,
      headers: authHeader(token),
      payload: { acknowledgeImpact: await currentDigest() },
    });
    expect(rejected.statusCode).toBe(409);
    const error = rejected.json().error as {
      code: string;
      message: string;
      details: { path: string; issue: string }[];
    };
    expect(error.code).toBe('STALE_DRAFT');
    expect(error.message).toContain('v1');
    expect(error.message).toContain('v2');
    expect(error.details).toEqual([
      { path: 'baseVersion', issue: 'v1' },
      { path: 'currentVersion', issue: 'v2' },
    ]);

    // Nothing was written. The definition is exactly where the other edit left it.
    const project = await reload();
    expect(project.currentVersion).toBe(2);
    expect(publishedVersionOf(project)).toBe(1);
  });

  it('is reported as stale on every read, without erroring', async () => {
    await goLive();
    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'number') },
    });

    const read = await app.inject({ method: 'GET', url: draftUrl(), headers: authHeader(token) });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ stale: true, baseVersion: 1, currentVersion: 2 });
  });

  /** Editing a stale draft still works — the user's work is not trapped. */
  it('remains editable while stale', async () => {
    await goLive();
    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'number') },
    });

    const edit = await app.inject({
      method: 'PATCH',
      url: draftUrl(),
      headers: authHeader(token),
      payload: {
        generationConfig: {
          validators: ['zod'],
          types: ['typescript'],
          methods: ['GET'],
          mockRecords: 5,
        },
      },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ stale: true });
  });

  it('can be re-forked against the current definition', async () => {
    await goLive();
    await app.inject({ method: 'POST', url: draftUrl(), headers: authHeader(token) });
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: retypeField((await reload()).ips, 'age', 'number') },
    });

    const reforked = await app.inject({
      method: 'POST',
      url: `${draftUrl()}/refork`,
      headers: authHeader(token),
    });
    expect(reforked.statusCode).toBe(200);
    expect(reforked.json()).toMatchObject({ stale: false, baseVersion: 2 });

    // And it now commits cleanly, because its diff is true again.
    const committable = await app.inject({
      method: 'GET',
      url: `${draftUrl()}/impact`,
      headers: authHeader(token),
    });
    expect(committable.json()).toMatchObject({ stale: false, changes: [] });
  });
});

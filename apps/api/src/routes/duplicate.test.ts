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
  Job,
  MockAuthSecret,
  MockSession,
  MockStore,
  MockUser,
  Project,
  Version,
  ensureAuthSecret,
} from '@instantmockapi/db';
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
 * Duplicate Project (Phase 4 §19, §25).
 *
 * §19 requires the duplicate to go through the blueprint pathway rather than
 * copying database documents, and §25 turns that into a list of things which
 * must *not* follow: users, sessions, auth secrets, mock records, jobs,
 * artifacts, runtime state.
 *
 * Those all hold by construction — every one of them lives in its own
 * collection keyed by project id, and the duplicate has a new id — so the tests
 * that matter are the ones that would notice if that stopped being true. Each
 * "not copied" case therefore seeds the source first: asserting a collection is
 * empty for the copy proves nothing if it was empty for the original too.
 */
let app: FastifyInstance;
let token: string;
let sourceId: string;

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
  sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
});

const duplicate = (id = sourceId, payload: unknown = {}, bearer = token) =>
  app.inject({
    method: 'POST',
    url: `/v1/projects/${id}/duplicate`,
    headers: authHeader(bearer),
    payload,
  });

const ipsOf = async (projectId: string): Promise<InternalProjectSchema> => {
  const project = await Project.findById(projectId);
  return project!.ips as InternalProjectSchema;
};

/** Everything a live, used project accumulates around its definition. */
async function seedRuntimeState(projectId: string): Promise<{ secret: string }> {
  const secret = await ensureAuthSecret(projectId);
  const user = await MockUser.create({
    projectId: projectId,
    email: 'end-user@example.com',
    passwordHash: 'scrypt$aaaa',
    fields: {},
  });
  await MockSession.create({
    projectId: projectId,
    userId: user._id,
    tokenHash: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    replacedBy: null,
  });
  await MockStore.create({
    projectId: projectId,
    entity: 'MainEntity',
    records: [{ id: 'rec_1', name: 'Ada' }],
  });
  await Artifact.create({
    projectId: projectId,
    artifactType: 'openapi',
    version: 1,
    status: 'completed',
  });
  await Version.create({
    projectId: projectId,
    version: 1,
    ipsSnapshot: await ipsOf(projectId),
    configSnapshot: (await Project.findById(projectId))!.generationConfig,
  });
  await Job.create({
    projectId: projectId,
    type: 'full',
    status: 'completed',
    version: 1,
    idempotencyKey: `seed-${projectId}`,
    requestedArtifacts: ['openapi'],
  });
  return { secret };
}

describe('§19: a duplicate is a new project', () => {
  it('returns 201 and a project that is not the source', async () => {
    const response = await duplicate();
    expect(response.statusCode, response.body).toBe(201);

    const copy = response.json();
    expect(copy.id).not.toBe(sourceId);
    expect(copy.status).toBe('draft');
    expect(copy.currentVersion).toBe(1);
    expect(await Project.countDocuments({})).toBe(2);
  });

  it('names the copy so the two are distinguishable', async () => {
    expect((await duplicate()).json().name).toBe('Shop (copy)');
  });

  it('takes a name and description override', async () => {
    const copy = (await duplicate(sourceId, { name: 'Shop v2', description: 'Next year' })).json();
    expect(copy.name).toBe('Shop v2');
    expect(copy.description).toBe('Next year');
  });

  /**
   * Its own addressing. `slug` is uniquely indexed per owner and the original
   * still holds `shop`, so this is the case that would fail on a duplicate key
   * if the copy tried to claim it.
   */
  it('mints its own public id and a non-colliding slug', async () => {
    const source = await Project.findById(sourceId);
    const copy = (await duplicate()).json();

    expect(copy.publicId).not.toBe(source!.publicId);
    expect(copy.publicId).toMatch(/^prj_[0-9a-f]+$/);
    expect(copy.slug).not.toBe(source!.slug);
  });

  /**
   * The copy's definition carries the copy's own addressing.
   *
   * Worth asserting, but **not** evidence for the blueprint pathway: that was
   * the first claim made for it and it was wrong. `createProjectRecord`
   * overwrites `publicId` and `slug` inside the definition after minting the
   * copy's own, so a direct `project.ips` copy would satisfy this too. The two
   * tests further down — re-validation and credential stripping — are the ones
   * a direct copy actually fails.
   */
  it('does not carry the original’s addressing into the copy’s definition', async () => {
    const source = await Project.findById(sourceId);
    const sourceIps = await ipsOf(sourceId);
    // The premise: the source's definition really does hold its addressing.
    expect(sourceIps.publicId).toBe(source!.publicId);

    const copy = (await duplicate()).json();
    const copyIps = await ipsOf(copy.id as string);

    expect(copyIps.publicId).toBe(copy.publicId);
    expect(copyIps.publicId).not.toBe(source!.publicId);
    expect(copyIps.slug).not.toBe(source!.slug);
    expect(JSON.stringify(copyIps)).not.toContain(String(source!.publicId));
  });

  it('leaves the source untouched', async () => {
    const before = JSON.stringify(await Project.findById(sourceId));
    await duplicate();
    expect(JSON.stringify(await Project.findById(sourceId))).toEqual(before);
  });
});

describe('§25: the canonical definition is preserved', () => {
  it('copies every entity, field and relation', async () => {
    const sourceIps = await ipsOf(sourceId);
    const copy = (await duplicate()).json();
    const copyIps = await ipsOf(copy.id as string);

    expect(copyIps.entities).toEqual(sourceIps.entities);
    expect(copyIps.generationConfig).toEqual(sourceIps.generationConfig);
  });

  /**
   * Stable ids survive, which is the reason to preserve them at all: the diff
   * engine pairs entities and fields by id, so a copy whose ids were re-minted
   * could not be compared against its original.
   */
  it('preserves stable ids', async () => {
    const sourceIps = await ipsOf(sourceId);
    const copyIps = await ipsOf((await duplicate()).json().id as string);

    const ids = (ips: InternalProjectSchema) =>
      ips.entities.flatMap((entity) => [entity.id, ...entity.fields.map((field) => field.id)]);
    expect(ids(copyIps)).toEqual(ids(sourceIps));
  });

  it('copies the authentication configuration', async () => {
    await Project.updateOne(
      { _id: sourceId },
      {
        $set: {
          'ips.authentication': {
            mode: 'ALL_PROTECTED',
            signup: true,
            signin: true,
            refreshToken: true,
            cookieAuth: true,
            accessTokenExpiresIn: '15m',
            refreshTokenExpiresIn: '7d',
            userFields: [{ name: 'displayName', type: 'string', required: true }],
          },
        },
      },
    );

    const copyIps = await ipsOf((await duplicate()).json().id as string);
    expect(copyIps.authentication?.mode).toBe('ALL_PROTECTED');
    expect(copyIps.authentication?.cookieAuth).toBe(true);
    expect(copyIps.authentication?.userFields).toEqual([
      { name: 'displayName', type: 'string', required: true },
    ]);
  });

  it.each(['project', 'single', 'auth'] as const)('duplicates a %s project', async (kind) => {
    // The kind is a property of the definition, so the copy has to keep it —
    // and it decides the public-id prefix, which is what this checks.
    await Project.updateOne({ _id: sourceId }, { $set: { kind, 'ips.kind': kind } });
    if (kind === 'auth') {
      await Project.updateOne(
        { _id: sourceId },
        {
          $set: {
            'ips.entities': [],
            'ips.authentication': {
              mode: 'ALL_PROTECTED',
              signup: true,
              signin: true,
              refreshToken: true,
              cookieAuth: false,
              accessTokenExpiresIn: '15m',
              refreshTokenExpiresIn: '7d',
              userFields: [],
            },
          },
        },
      );
    }

    const response = await duplicate();
    expect(response.statusCode, response.body).toBe(201);

    const copy = response.json();
    expect(copy.kind).toBe(kind);
    expect(copy.publicId).toMatch(
      new RegExp(`^${{ project: 'prj', single: 'sng', auth: 'aut' }[kind]}_`),
    );
  });
});

describe('§19/§25: what does not follow the copy', () => {
  it('copies no end users', async () => {
    await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    // Seeded, so an empty result for the copy means something.
    expect(await MockUser.countDocuments({ projectId: sourceId })).toBe(1);
    expect(await MockUser.countDocuments({ projectId: copyId })).toBe(0);
  });

  it('copies no sessions', async () => {
    await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    expect(await MockSession.countDocuments({ projectId: sourceId })).toBe(1);
    expect(await MockSession.countDocuments({ projectId: copyId })).toBe(0);
  });

  /**
   * §19 asks for "generate new runtime secrets", and the copy gets one by
   * having none: `MockAuthSecret` is minted lazily, so the first token request
   * against the duplicate creates a key that has never existed anywhere else.
   * That is also §26's isolation requirement — a token signed for the source
   * fails verification against the copy, with no claim check to forget.
   */
  it('copies no auth secret, and mints a different one on demand', async () => {
    const { secret } = await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    expect(await MockAuthSecret.countDocuments({ projectId: copyId })).toBe(0);

    const copySecret = await ensureAuthSecret(copyId);
    expect(copySecret).not.toBe(secret);
    // And the source's key is untouched by the copy's minting.
    expect(await ensureAuthSecret(sourceId)).toBe(secret);
  });

  it('copies no mock records', async () => {
    await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    expect(await MockStore.countDocuments({ projectId: sourceId })).toBe(1);
    expect(await MockStore.countDocuments({ projectId: copyId })).toBe(0);
  });

  it('copies no generation jobs', async () => {
    await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    expect(await Job.countDocuments({ projectId: sourceId })).toBe(1);
    expect(await Job.countDocuments({ projectId: copyId })).toBe(0);
  });

  /**
   * §25 allows artifacts to follow "if explicitly required by existing
   * architecture", and nothing requires it: an `Artifact` row is keyed
   * `(projectId, type, version)` and its content is produced by a worker from
   * the definition. The copy generates its own, which is also the only way its
   * artifacts can carry its own hosted URL.
   */
  it('copies no artifacts or version history', async () => {
    await seedRuntimeState(sourceId);
    const copyId = (await duplicate()).json().id as string;

    expect(await Artifact.countDocuments({ projectId: sourceId })).toBe(1);
    expect(await Artifact.countDocuments({ projectId: copyId })).toBe(0);
    expect(await Version.countDocuments({ projectId: copyId })).toBe(0);
  });

  it('copies no hosted deployment', async () => {
    await Project.updateOne(
      { _id: sourceId },
      {
        $set: {
          status: 'active',
          'hosted.url': 'https://api.example.dev/prj_source/shop',
          'hosted.expiresAt': new Date(Date.now() + 86_400_000),
        },
      },
    );

    const copy = (await duplicate()).json();
    const stored = await Project.findById(copy.id as string);

    expect(stored!.status).toBe('draft');
    expect(stored!.hosted?.url ?? null).toBeNull();
  });
});

describe('§25: the copy is independently editable', () => {
  /**
   * The failure this catches is a shared reference: if the copy's definition
   * aliased the source's stored object, editing one would change both. The
   * blueprint round trip deep-copies through JSON, so it cannot — but that is a
   * property of a function three layers away, which is exactly the kind of
   * thing worth pinning at the boundary that depends on it.
   */
  it('renaming an entity in the copy leaves the source alone', async () => {
    const copyId = (await duplicate()).json().id as string;
    const sourceBefore = await ipsOf(sourceId);

    const copyIps = await ipsOf(copyId);
    copyIps.entities[0]!.name = 'RenamedInCopy';
    await Project.updateOne({ _id: copyId }, { $set: { ips: copyIps } });

    expect((await ipsOf(sourceId)).entities[0]!.name).toBe(sourceBefore.entities[0]!.name);
    expect((await ipsOf(copyId)).entities[0]!.name).toBe('RenamedInCopy');
  });

  it('accepts a definition edit through the normal route', async () => {
    const copyId = (await duplicate()).json().id as string;

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${copyId}`,
      headers: authHeader(token),
      payload: { description: 'Edited after duplication' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((await Project.findById(copyId))!.description).toBe('Edited after duplication');
  });
});

describe('access and plan', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${sourceId}/duplicate`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not duplicate another user’s project', async () => {
    const other = (await login(app, 'intruder@example.com')).accessToken;
    expect((await duplicate(sourceId, {}, other)).statusCode).toBe(404);
    expect(await Project.countDocuments({})).toBe(1);
  });

  it('404s a malformed id', async () => {
    expect((await duplicate('not-an-object-id')).statusCode).toBe(404);
  });

  /**
   * A duplicate is a create, so it counts against the plan — and the source is
   * loaded first, so an unauthorised request gets a 404 rather than being told
   * about a quota it has no business knowing.
   */
  it('refuses when the plan is full, creating nothing', async () => {
    const owner = (await Project.findById(sourceId))!.ownerId;
    await Project.insertMany(
      Array.from({ length: 9 }, (_, index) => ({
        ownerId: owner,
        name: `Filler ${index}`,
        kind: 'project',
        status: 'draft',
        inputSource: { type: 'json', raw: '{}' },
        ips: { projectId: 'x', version: 1, entities: [], generationConfig: {} },
        generationConfig: {},
        currentVersion: 1,
      })),
    );
    const before = await Project.countDocuments({});

    const response = await duplicate();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(await Project.countDocuments({})).toBe(before);
  });
});

describe('§19: what the blueprint pathway actually buys', () => {
  /**
   * Duplicating a project whose stored definition no longer validates fails,
   * with the offending field named.
   *
   * Reachable rather than theoretical: a `Mixed` `ips` field can hold a
   * document written before a validator gained a check, or one a migration
   * edited. The alternative implementation — copy `project.ips` into a new
   * document — would happily create a project nobody can then edit, because
   * every edit path runs `validateIPS` and would reject it from that point on.
   *
   * This is one of the two tests a direct copy fails.
   */
  it('refuses to duplicate a definition that no longer validates', async () => {
    /*
     * Corrupted through the loaded document, not a dotted `$set`.
     *
     * `ips` is a `Mixed` path, so mongoose does not track a dotted update into
     * it the way it would a declared subdocument — `$set` with
     * `'ips.entities.0.fields.1.type'` left the stored document unchanged and
     * the test passed against a project that was never broken. Writing the
     * whole field back is what actually corrupts it.
     *
     * `fields[1]`, not `fields[0]`: index 0 is the derived identity field,
     * which `materializeRelations` rewrites during normalization, so
     * corrupting that one is silently undone.
     */
    const stored = await ipsOf(sourceId);
    stored.entities[0]!.fields[1]!.type = 'timestamp' as never;
    await Project.updateOne({ _id: sourceId }, { $set: { ips: stored } });
    expect((await ipsOf(sourceId)).entities[0]!.fields[1]!.type).toBe('timestamp');

    const before = await Project.countDocuments({});

    const response = await duplicate();

    expect(response.statusCode, response.body).toBe(422);
    expect(await Project.countDocuments({})).toBe(before);
    const details = response.json().error.details as { path: string; issue: string }[];
    expect(details.some((detail) => detail.path.includes('fields[1].type'))).toBe(true);
  });

  /**
   * A credential-named key in the source's stored auth block does not
   * propagate.
   *
   * Also reachable: `parseBuilderPayload` passes the wizard payload's
   * `authentication` block straight through and `validateAuth` does not reject
   * keys it does not know, so a project can hold a stray `signingKey` in there.
   * `buildBlueprint` omits it — §12 requires the file a blueprint produces to
   * be safe to share, and the duplicate inherits that safety for free.
   *
   * The second of the two tests a direct copy fails.
   */
  it('does not propagate a credential-named key from the source’s auth block', async () => {
    await Project.updateOne(
      { _id: sourceId },
      {
        $set: {
          'ips.authentication': {
            mode: 'ALL_PROTECTED',
            signup: true,
            signin: true,
            refreshToken: true,
            cookieAuth: false,
            accessTokenExpiresIn: '15m',
            refreshTokenExpiresIn: '7d',
            userFields: [],
            signingKey: 'a3f9c1e07b4d28650f1a9c3e7d5b8402',
          },
        },
      },
    );
    // The premise: the source really does hold it.
    expect(JSON.stringify(await ipsOf(sourceId))).toContain('signingKey');

    const copyId = (await duplicate()).json().id as string;
    const copyIps = JSON.stringify(await ipsOf(copyId));

    expect(copyIps).not.toContain('signingKey');
    expect(copyIps).not.toContain('a3f9c1e07b4d28650f1a9c3e7d5b8402');
    // The configuration itself still crosses — only the junk is dropped.
    expect((await ipsOf(copyId)).authentication?.mode).toBe('ALL_PROTECTED');
  });
});

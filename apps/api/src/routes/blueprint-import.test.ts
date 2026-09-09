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
import { Job, MockAuthSecret, Project, ensureAuthSecret } from '@instantmockapi/db';
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
 * Blueprint import (Phase 4 §14, §15, §24, §26).
 *
 * The use case this exists for: a hosted API expires after two days on the free
 * plan, so a developer exports a blueprint and imports it to stand the same
 * project up again in minutes. That shapes what is worth testing — the
 * *complete* export-then-import cycle through the HTTP surface, for all three
 * project kinds, including from an expired project.
 *
 * The format's rules are covered in `packages/ips/src/blueprint.test.ts`. What
 * is tested here is what only the route can get wrong: that a rejected
 * blueprint creates nothing, that the new project is genuinely new, and that
 * the two projects share no credential.
 */
let app: FastifyInstance;
let token: string;

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
});

const exportOf = (projectId: string, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${projectId}/blueprint`,
    headers: authHeader(bearer),
  });

const importBlueprint = (payload: unknown, bearer = token) =>
  app.inject({
    method: 'POST',
    url: '/v1/projects/import',
    headers: authHeader(bearer),
    payload,
  });

/** Create a project of any kind through the same route a wizard uses. */
const createOfKind = (kind: 'project' | 'single' | 'auth', name: string) => {
  if (kind === 'auth') {
    return app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeader(token),
      payload: {
        name,
        kind: 'auth',
        inputSource: {
          type: 'builder',
          raw: JSON.stringify({
            entities: [],
            generationConfig: {
              validators: [],
              types: ['typescript'],
              methods: ['GET', 'POST'],
              mockRecords: 0,
              features: { search: false, filter: false, sort: false, include: false },
            },
            authentication: {
              mode: 'ALL_PROTECTED',
              signup: true,
              signin: true,
              refreshToken: true,
              cookieAuth: false,
              accessTokenExpiresIn: '15m',
              refreshTokenExpiresIn: '7d',
              userFields: [{ name: 'displayName', type: 'string', required: true }],
            },
          }),
        },
      },
    });
  }
  return app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: authHeader(token),
    payload: {
      name,
      kind,
      inputSource: { type: 'json', raw: { customer: { name: 'Ada', email: 'a@b.co', age: 36 } } },
    },
  });
};

const ipsOf = async (projectId: string): Promise<InternalProjectSchema> => {
  const project = await Project.findById(projectId);
  return project!.ips as InternalProjectSchema;
};

describe('§15: import creates a new project', () => {
  it('returns 201 and a project that is not the source', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();

    const response = await importBlueprint({ blueprint });
    expect(response.statusCode, response.body).toBe(201);

    const created = response.json();
    expect(created.id).not.toBe(sourceId);
    expect(created.name).toBe('Shop');
    expect(created.status).toBe('draft');
    expect(created.currentVersion).toBe(1);
    expect(await Project.countDocuments({})).toBe(2);
  });

  /**
   * Its own addressing, and a slug that does not fight the original.
   *
   * `slug` is uniquely indexed per owner, so importing back into the account a
   * blueprint came from is the case that would otherwise fail on a duplicate
   * key. `ensurePublicIdentity` suffixes instead.
   */
  it('mints its own public id and a non-colliding slug', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const source = await Project.findById(sourceId);
    const blueprint = (await exportOf(sourceId)).json();

    const created = (await importBlueprint({ blueprint })).json();

    expect(created.publicId).toMatch(/^prj_[0-9a-f]+$/);
    expect(created.publicId).not.toBe(source!.publicId);
    expect(created.slug).not.toBe(source!.slug);
    expect(created.slug).toBe(`${source!.slug}-2`);
  });

  it('takes a name override, for a copy alongside the original', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();

    const created = (await importBlueprint({ blueprint, name: 'Shop rebuilt' })).json();
    expect(created.name).toBe('Shop rebuilt');
  });

  /**
   * Stable ids from birth, exactly as a created project gets them.
   *
   * The blueprint preserves the source's ids, so this is really a check that
   * `createProjectRecord`'s `ensureSchemaIds` did not re-mint them: a duplicate
   * whose ids were regenerated could not be compared against its original by
   * the diff engine, which pairs on id.
   */
  it('keeps the definition’s stable ids', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const sourceIps = await ipsOf(sourceId);
    const blueprint = (await exportOf(sourceId)).json();

    const created = (await importBlueprint({ blueprint })).json();
    const importedIps = await ipsOf(created.id as string);

    expect(importedIps.entities.map((entity) => entity.id)).toEqual(
      sourceIps.entities.map((entity) => entity.id),
    );
  });

  it('does not touch the source project', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const before = JSON.stringify(await Project.findById(sourceId));
    const blueprint = (await exportOf(sourceId)).json();

    await importBlueprint({ blueprint });

    expect(JSON.stringify(await Project.findById(sourceId))).toEqual(before);
  });
});

describe('the expiry workflow, end to end', () => {
  /**
   * The reason this feature exists: a free-plan hosted API lasts two days, so
   * the definition has to survive its own deployment.
   *
   * §23 requires an expired project to retain its definition, its Technical
   * Notes and its Blueprint export — this is that requirement as a test, and it
   * is the one that would break silently if a future retention sweep started
   * clearing `ips`.
   */
  it('exports from an expired project and imports it back', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    await Project.updateOne(
      { _id: sourceId },
      { $set: { status: 'expired', 'hosted.expiresAt': new Date(Date.now() - 1000) } },
    );

    const exported = await exportOf(sourceId);
    expect(exported.statusCode, exported.body).toBe(200);

    const response = await importBlueprint({ blueprint: exported.json() });
    expect(response.statusCode, response.body).toBe(201);

    const created = response.json();
    // A fresh project, not an expired one — ready to generate.
    expect(created.status).toBe('draft');
    expect((await ipsOf(created.id as string)).entities.length).toBeGreaterThan(0);
  });
});

describe('§15: every project kind round-trips', () => {
  it.each(['project', 'single', 'auth'] as const)('imports a %s blueprint', async (kind) => {
    const created = await createOfKind(kind, `Source ${kind}`);
    expect(created.statusCode, created.body).toBe(201);
    const sourceId = created.json().id as string;

    const blueprint = (await exportOf(sourceId)).json();
    expect(blueprint.project.kind).toBe(kind);

    const response = await importBlueprint({ blueprint });
    expect(response.statusCode, response.body).toBe(201);

    const imported = response.json();
    expect(imported.kind).toBe(kind);
    // The public-id prefix is chosen by kind, so this also proves the kind was
    // set on the document *before* identity was minted.
    expect(imported.publicId).toMatch(
      new RegExp(`^${{ project: 'prj', single: 'sng', auth: 'aut' }[kind]}_`),
    );
  });

  /**
   * An Auth API project has no entities and its whole surface is the five login
   * endpoints. `validateIPS` waives the at-least-one-entity rule for this kind
   * alone, which is why the kind has to reach normalization rather than being
   * stamped on afterwards.
   */
  it('imports an auth project with no entities and keeps its configuration', async () => {
    const sourceId = (await createOfKind('auth', 'Accounts')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();

    const created = (await importBlueprint({ blueprint })).json();
    const ips = await ipsOf(created.id as string);

    expect(ips.entities).toEqual([]);
    expect(ips.authentication?.mode).toBe('ALL_PROTECTED');
    expect(ips.authentication?.userFields).toEqual([
      { name: 'displayName', type: 'string', required: true },
    ]);
  });
});

describe('§14: import is transactional', () => {
  const countProjects = () => Project.countDocuments({});

  it.each([
    ['a blueprint that is not an object', 'nope'],
    ['a blueprint with no version', { project: { name: 'X', kind: 'project' } }],
    ['a blueprint from a newer build', { blueprintVersion: 99 }],
  ])('creates nothing for %s', async (_label, blueprint) => {
    const before = await countProjects();

    const response = await importBlueprint({ blueprint });
    expect(response.statusCode).toBe(422);
    expect(await countProjects()).toBe(before);
  });

  it('creates nothing for a malformed field type', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();
    blueprint.entities[0].fields[0].type = 'timestamp';
    const before = await countProjects();

    const response = await importBlueprint({ blueprint });

    expect(response.statusCode).toBe(422);
    expect(await countProjects()).toBe(before);
  });

  it('creates nothing for a blueprint carrying a credential', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();
    blueprint.signingKey = 'a3f9c1e07b4d28650f1a9c3e7d5b8402';
    const before = await countProjects();

    const response = await importBlueprint({ blueprint });

    expect(response.statusCode).toBe(422);
    expect(await countProjects()).toBe(before);
  });

  /**
   * §14 asks for structured errors identifying path, field and reason. The
   * detail list comes straight from `readBlueprint`, which is the same
   * vocabulary the create route and the editor already report — §14's "do not
   * create a second error system".
   */
  it('returns a path and a reason for every problem', async () => {
    const response = await importBlueprint({ blueprint: { blueprintVersion: 1 } });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.length).toBeGreaterThan(0);
    for (const detail of body.error.details) {
      expect(detail.path, JSON.stringify(detail)).not.toBe('');
      expect(detail.issue.length, JSON.stringify(detail)).toBeGreaterThan(3);
    }
  });

  /** §14: no generation jobs. A failed import must not leave work queued. */
  it('queues no job, on success or failure', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();

    await importBlueprint({ blueprint });
    await importBlueprint({ blueprint: { blueprintVersion: 1 } });

    expect(await Job.countDocuments({})).toBe(0);
  });

  it('rejects a request with no blueprint at all', async () => {
    expect((await importBlueprint({})).statusCode).toBe(400);
  });
});

describe('§26: the two projects share no credential', () => {
  /**
   * §26's isolation requirement, proven at the storage layer.
   *
   * `MockAuthSecret` is keyed by project id and minted lazily, so an imported
   * project starts with no row at all — there is nothing to copy and no code
   * path that could. The keys are then necessarily different, which is what
   * makes a token signed for the source fail verification against the copy:
   * per-project keys make the isolation structural rather than a claim check
   * somebody has to remember to write.
   */
  it('gives the imported project a key that never existed before', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const sourceSecret = await ensureAuthSecret(sourceId);
    const blueprint = (await exportOf(sourceId)).json();

    const importedId = (await importBlueprint({ blueprint })).json().id as string;

    // Nothing was copied: the new project has no key until it needs one.
    expect(await MockAuthSecret.countDocuments({ projectId: importedId })).toBe(0);

    const importedSecret = await ensureAuthSecret(importedId);
    expect(importedSecret).not.toBe(sourceSecret);
    expect(await MockAuthSecret.countDocuments({})).toBe(2);
  });

  it('carries no trace of the source project’s identity', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const source = await Project.findById(sourceId);
    const blueprint = (await exportOf(sourceId)).json();

    const importedId = (await importBlueprint({ blueprint })).json().id as string;
    const stored = JSON.stringify(await Project.findById(importedId));

    expect(stored).not.toContain(sourceId);
    expect(stored).not.toContain(String(source!.publicId));
  });
});

describe('a blueprint moves between accounts', () => {
  /**
   * The portability §11 is for: a file a user was sent.
   *
   * Also the case where nothing can be inferred from context — the importer has
   * never seen the source project and cannot read it — so if the blueprint were
   * missing anything, this is where it would show.
   */
  it('imports into a different account with the definition intact', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const sourceIps = await ipsOf(sourceId);
    const blueprint = (await exportOf(sourceId)).json();

    const other = (await login(app, 'friend@example.com')).accessToken;
    const response = await importBlueprint({ blueprint }, other);
    expect(response.statusCode, response.body).toBe(201);

    const imported = await ipsOf(response.json().id as string);
    expect(imported.entities).toEqual(sourceIps.entities);
    expect(imported.generationConfig).toEqual(sourceIps.generationConfig);
  });

  it('does not let the importer read the source project', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const other = (await login(app, 'friend@example.com')).accessToken;

    expect((await exportOf(sourceId, other)).statusCode).toBe(404);
  });
});

describe('plan and access', () => {
  it('rejects an unauthenticated import', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/import',
      payload: { blueprint: { blueprintVersion: 1 } },
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * An import is a create, so it counts against the plan — and it is refused
   * *before* the blueprint is read, so a user at their limit gets the reason
   * that matters rather than a validation error about a file that was fine.
   */
  it('refuses when the plan is full, without creating anything', async () => {
    const sourceId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
    const blueprint = (await exportOf(sourceId)).json();

    // The free plan's ceiling is 10; fill it.
    const owner = (await Project.findById(sourceId))!.ownerId;
    const filler = Array.from({ length: 9 }, (_, index) => ({
      ownerId: owner,
      name: `Filler ${index}`,
      kind: 'project',
      status: 'draft',
      inputSource: { type: 'json', raw: '{}' },
      ips: { projectId: 'x', version: 1, entities: [], generationConfig: {} },
      generationConfig: {},
      currentVersion: 1,
    }));
    await Project.insertMany(filler);
    const before = await Project.countDocuments({});

    const response = await importBlueprint({ blueprint });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(await Project.countDocuments({})).toBe(before);
  });
});

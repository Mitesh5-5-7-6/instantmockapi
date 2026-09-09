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
import { MockAuthSecret, Project, ensureAuthSecret } from '@instantmockapi/db';
import { readBlueprint } from '@instantmockapi/ips';
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
 * Blueprint export (Phase 4 §17, §24, §26).
 *
 * The format's own rules are tested exhaustively in `packages/ips` — the
 * whitelist, the round trip, the credential handling. What is left to the route
 * is what only the route can get wrong: which project's definition it reads,
 * what the response body is, who is allowed to ask, and — §26's requirement —
 * that a *real* signing key existing on the server does not reach the file.
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

const exportBlueprint = (id = projectId, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${id}/blueprint`,
    headers: authHeader(bearer),
  });

describe('§17: the export route', () => {
  it('returns the blueprint as the response body', async () => {
    const response = await exportBlueprint();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      'blueprintVersion',
      'entities',
      'generationConfig',
      'metadata',
      'project',
      'schemaVersion',
    ]);
    expect(body.project.name).toBe('Shop');
    expect(body.project.kind).toBe('project');
  });

  /**
   * The body is the file, so what the route returns must be importable as-is.
   *
   * This is the assertion that makes the two halves agree: `readBlueprint` is
   * the same pipeline an import will run, so a route that emitted something
   * subtly wrong fails here rather than at the moment a user tries to use the
   * file they saved.
   */
  it('produces a file the importer accepts', async () => {
    const result = readBlueprint((await exportBlueprint()).json(), { projectId: 'p_other' });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    if (result.ok) {
      expect(result.value.ips.projectId).toBe('p_other');
      expect(result.value.ips.version).toBe(1);
    }
  });

  it('carries the definition the project was created from', async () => {
    const body = (await exportBlueprint()).json();

    expect(body.entities.length).toBeGreaterThan(0);
    expect(body.entities[0].name).toBe('MainEntity');
    expect(body.metadata.sourceVersion).toBe(1);
  });

  /**
   * §17's suffix, with the project's own stem — a user exporting three projects
   * into one folder otherwise gets `project.blueprint (1).json`.
   */
  it('advertises a filename so a direct hit on the URL saves', async () => {
    await Project.updateOne({ _id: projectId }, { $set: { slug: 'shop' } });
    const response = await exportBlueprint();

    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="shop.blueprint.json"',
    );
  });

  /**
   * A project with no slug at all.
   *
   * Not hypothetical, and not what a newly created project looks like: the
   * create path derives a slug from the name, so this fallback exists for
   * documents written before slugs did — the same population the partial unique
   * index on `{ownerId, slug}` was written for.
   */
  it('falls back to a generic filename for a project with no slug', async () => {
    await Project.updateOne({ _id: projectId }, { $unset: { slug: '' } });

    expect((await exportBlueprint()).headers['content-disposition']).toBe(
      'attachment; filename="project.blueprint.json"',
    );
  });

  /**
   * No clock in the file, so two exports of an unchanged project are identical.
   * That is what lets a user diff two blueprints and see only their own edits.
   */
  it('exports byte-identically twice', async () => {
    expect((await exportBlueprint()).body).toEqual((await exportBlueprint()).body);
  });

  it('has no timestamp at all', async () => {
    const body = (await exportBlueprint()).body;
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(body).not.toContain('exportedAt');
  });
});

describe('§12: addressing and runtime state stay behind', () => {
  /**
   * The project has a public id, a slug, a hosted URL and a status. None of
   * them describe the *definition*, and `slug` is uniquely indexed per owner —
   * so a blueprint carrying one could not be imported back into the account it
   * came from, which is exactly the Duplicate Project case.
   */
  it('carries no addressing, hosted URL or status', async () => {
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          publicId: 'prj_leaky01',
          slug: 'live-shop',
          status: 'active',
          'hosted.url': 'https://api.example.dev/prj_leaky01/live-shop',
        },
      },
    );

    const body = (await exportBlueprint()).body;

    expect(body).not.toContain('prj_leaky01');
    expect(body).not.toContain('live-shop');
    expect(body).not.toContain('hosted');
    expect(body).not.toContain('publicId');
    expect(body).not.toContain('slug');
    expect(body).not.toContain('projectId');
  });

  it('carries no version history or job state', async () => {
    const body = (await exportBlueprint()).body;

    for (const term of ['publishedVersion', 'currentVersion', 'artifact', 'jobId', 'expiresAt']) {
      expect(body, term).not.toContain(term);
    }
  });
});

describe('§26: export is not secret export', () => {
  /**
   * The test §26 asks for, with a real key rather than a planted string.
   *
   * `ensureAuthSecret` mints the project's actual signing key — 256 bits of
   * CSPRNG output — and the assertion is that its value does not appear in the
   * exported file. A planted fake would prove less: this is the value that
   * actually signs the project's tokens.
   *
   * It passes by construction, because the key lives in `MockAuthSecret` and
   * the exporter never queries that collection. The test exists so that stays
   * true when someone later decides the blueprint should carry "just the auth
   * settings" and reaches for a wider query.
   */
  it('does not contain the project’s real signing key', async () => {
    const project = await Project.findById(projectId);
    const secret = await ensureAuthSecret(String(project!._id));
    expect(secret.length).toBeGreaterThan(32);

    const body = (await exportBlueprint()).body;

    expect(body).not.toContain(secret);
    // Nor any prefix long enough to be useful.
    expect(body).not.toContain(secret.slice(0, 16));
  });

  it('leaves the secret in its own collection, unread', async () => {
    const project = await Project.findById(projectId);
    await ensureAuthSecret(String(project!._id));

    await exportBlueprint();

    // Exporting neither mints nor rotates a key.
    expect(await MockAuthSecret.countDocuments({ projectId: project!._id })).toBe(1);
  });

  /**
   * §26's list of forbidden terms, searched in the serialized blueprint.
   *
   * Term-shaped rather than value-shaped, so it also catches a *field named*
   * like a credential appearing in the envelope — which is the form the leak
   * would take if someone widened what the exporter copies.
   */
  it('contains none of the forbidden credential terms', async () => {
    await Project.updateOne(
      { _id: projectId },
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
          },
        },
      },
    );

    const body = (await exportBlueprint()).body.toLowerCase();

    for (const term of [
      'jwtsecret',
      'signingkey',
      'authsecret',
      'passwordhash',
      'sessionhash',
      'tokenhash',
      'mongodb://',
      'mongodb+srv://',
      'redis://',
      'apikey',
    ]) {
      expect(body, term).not.toContain(term);
    }
  });

  /**
   * The auth *configuration* is portable — §16 — so the export must carry it.
   * A test that only proved absence would be satisfied by an exporter that
   * dropped authentication entirely, which would silently lose the project's
   * access model on import.
   */
  it('does carry the authentication configuration', async () => {
    await Project.updateOne(
      { _id: projectId },
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

    const body = (await exportBlueprint()).json();

    expect(body.authentication.mode).toBe('ALL_PROTECTED');
    expect(body.authentication.cookieAuth).toBe(true);
    expect(body.authentication.refreshToken).toBe(true);
    expect(body.authentication.userFields).toEqual([
      { name: 'displayName', type: 'string', required: true },
    ]);
  });
});

describe('§40: access', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/blueprint`,
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * A blueprint is the whole definition of a project, so this is the route
   * where a broken ownership check would be worst: it would hand a stranger
   * everything about someone else's schema in one request.
   */
  it('does not export another user’s project', async () => {
    const other = (await login(app, 'intruder@example.com')).accessToken;
    expect((await exportBlueprint(projectId, other)).statusCode).toBe(404);
  });

  it('404s a malformed id', async () => {
    expect((await exportBlueprint('not-an-object-id')).statusCode).toBe(404);
  });
});

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
 * Phase 4 end to end (§26, §28, §29).
 *
 * The individual surfaces are covered where they live — the format's rules in
 * `packages/ips/src/blueprint.test.ts`, each route in its own file, the runtime
 * isolation in `apps/mock-runtime`. What is left, and what this file is for, is
 * the *chain*: document a project, export it, import it, and document the copy,
 * all through HTTP, asserting the things that can only go wrong when the pieces
 * meet.
 *
 * Two claims that no single-route test can make:
 *
 * - The loop closes. A blueprint exported from a project imports into one whose
 *   documentation says the same thing about the data model — so the definition
 *   survived four transformations without drifting.
 * - The copy is independent. Same definition, different identity, different
 *   credentials, and editing one does not touch the other.
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

const get = (url: string) => app.inject({ method: 'GET', url, headers: authHeader(token) });
const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: authHeader(token), payload });

const notesOf = (id: string) => get(`/v1/projects/${id}/technical-notes`);
const aiOf = (id: string) => get(`/v1/projects/${id}/technical-notes/ai`);
const blueprintOf = (id: string) => get(`/v1/projects/${id}/blueprint`);

/** The `## Data model` half of a Technical Notes document. */
function dataModelSection(markdown: string): string {
  const after = markdown.split('## Data model')[1] ?? '';
  return after.split('## Relationships')[0] ?? after;
}

describe('§29: the whole loop closes', () => {
  /**
   * Export, import, and compare the documentation of both.
   *
   * The data-model section is compared rather than the whole document, because
   * the rest legitimately differs: the title carries the project name and the
   * Project section carries the copy's own addressing. Everything that
   * describes the *definition* has to be identical, and that is what this pins.
   */
  it('a project and its imported copy document the same data model', async () => {
    const blueprint = (await blueprintOf(sourceId)).json();

    const imported = await post('/v1/projects/import', { blueprint });
    expect(imported.statusCode, imported.body).toBe(201);
    const copyId = imported.json().id as string;

    const sourceNotes = (await notesOf(sourceId)).json().markdown;
    const copyNotes = (await notesOf(copyId)).json().markdown;

    /*
     * Non-empty first. Comparing two extracted sections is only meaningful if
     * the extraction found anything — equal empty strings would pass this test
     * against a renderer that emitted no data model at all.
     */
    expect(dataModelSection(sourceNotes)).toContain('MainEntity');
    expect(dataModelSection(sourceNotes).length).toBeGreaterThan(200);
    expect(dataModelSection(copyNotes)).toEqual(dataModelSection(sourceNotes));
  });

  it('and the same AI context, apart from the project’s own identity', async () => {
    const blueprint = (await blueprintOf(sourceId)).json();
    const copyId = (await post('/v1/projects/import', { blueprint })).json().id as string;

    const strip = (context: string): string =>
      context
        .split('\n')
        .filter((line) => !/^(Name|Public ID|Base Path|Base URL):/.test(line))
        .join('\n');

    const sourceContext = strip((await aiOf(sourceId)).json().context);
    // Same vacuity guard: the stripped document must still be a document.
    expect(sourceContext).toContain('## Entities');
    expect(sourceContext).toContain('## APIs');

    expect(strip((await aiOf(copyId)).json().context)).toEqual(sourceContext);
  });

  /**
   * Re-exporting the copy produces the same blueprint the import consumed.
   *
   * §25's round-trip requirement, through HTTP rather than in-process. The
   * `metadata.sourceVersion` legitimately differs — the copy was taken from its
   * own v1 — and `project.name`/`description` carry the copy's identity, so the
   * comparison is over the definition.
   */
  it('re-exporting the copy yields the same definition', async () => {
    const first = (await blueprintOf(sourceId)).json();
    const copyId = (await post('/v1/projects/import', { blueprint: first })).json().id as string;
    const second = (await blueprintOf(copyId)).json();

    expect(second.entities).toEqual(first.entities);
    expect(second.generationConfig).toEqual(first.generationConfig);
    expect(second.blueprintVersion).toBe(first.blueprintVersion);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    expect(second.project.kind).toBe(first.project.kind);
  });

  /**
   * Three laps, because a drift of one field per lap is invisible in one.
   *
   * Each hop is export → import, so anything that normalisation adds or loses
   * would accumulate — a default filled in, a derived field duplicated, a
   * stable id re-minted.
   */
  it('survives three export/import laps unchanged', async () => {
    let currentId = sourceId;
    const first = (await blueprintOf(currentId)).json();

    for (let lap = 0; lap < 3; lap += 1) {
      const blueprint = (await blueprintOf(currentId)).json();
      const response = await post('/v1/projects/import', {
        blueprint,
        name: `Lap ${lap}`,
      });
      expect(response.statusCode, response.body).toBe(201);
      currentId = response.json().id as string;
    }

    const last = (await blueprintOf(currentId)).json();
    expect(last.entities).toEqual(first.entities);
    expect(last.generationConfig).toEqual(first.generationConfig);
  });
});

describe('§26: the copy shares no credential with its source', () => {
  /**
   * The storage-layer half of §26's isolation requirement. The other half —
   * that a real token from one is refused by the other — is proven against the
   * actual runtime in `apps/mock-runtime/src/auth/runtime-auth.test.ts`, which
   * is the only place a token can actually be verified.
   */
  it('mints the copy its own signing key, with one already sitting there', async () => {
    const sourceSecret = await ensureAuthSecret(sourceId);

    const blueprint = (await blueprintOf(sourceId)).json();
    const copyId = (await post('/v1/projects/import', { blueprint })).json().id as string;

    // Nothing copied, with a key there to copy.
    expect(await MockAuthSecret.countDocuments({ projectId: copyId })).toBe(0);
    expect(await ensureAuthSecret(copyId)).not.toBe(sourceSecret);
  });

  it('does the same for a duplicate', async () => {
    const sourceSecret = await ensureAuthSecret(sourceId);
    const copyId = (await post(`/v1/projects/${sourceId}/duplicate`)).json().id as string;

    expect(await MockAuthSecret.countDocuments({ projectId: copyId })).toBe(0);
    expect(await ensureAuthSecret(copyId)).not.toBe(sourceSecret);
  });
});

describe('§26: no document carries a credential', () => {
  /**
   * §26 asks for the *generated Technical Notes* to be searched as well as the
   * blueprint, and with a real credential present rather than a term list over
   * a project that never had one.
   *
   * `ensureAuthSecret` mints the project's actual 256-bit signing key. It
   * cannot reach any of these documents — it lives in `MockAuthSecret`, which
   * none of the three readers query — so this passes by construction. It exists
   * so that stays true when someone decides the notes should mention "the auth
   * settings" and reaches for a wider query.
   */
  it('keeps the real signing key out of all three documents', async () => {
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
    const secret = await ensureAuthSecret(sourceId);
    expect(secret.length).toBeGreaterThan(32);

    const bodies = [
      (await notesOf(sourceId)).body,
      (await aiOf(sourceId)).body,
      (await blueprintOf(sourceId)).body,
    ];

    for (const body of bodies) {
      expect(body).not.toContain(secret);
      // Nor a prefix long enough to be worth brute-forcing the rest of.
      expect(body).not.toContain(secret.slice(0, 16));
    }
  });

  /**
   * §26's forbidden-term list, across every document Phase 4 produces.
   *
   * Term-shaped as well as value-shaped: a *field named* like a credential
   * appearing in a document is the form the leak would take if someone widened
   * what a serializer copies, and no planted value would catch that.
   */
  it('contains none of §26’s forbidden terms, in any document', async () => {
    await ensureAuthSecret(sourceId);
    const bodies = [
      ['technical notes', (await notesOf(sourceId)).body],
      ['ai context', (await aiOf(sourceId)).body],
      ['blueprint', (await blueprintOf(sourceId)).body],
    ] as const;

    for (const [label, body] of bodies) {
      const lower = body.toLowerCase();
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
        'refreshtoken:',
        'accesstoken:',
      ]) {
        expect(lower, `${label}: ${term}`).not.toContain(term);
      }
    }
  });

  /**
   * The auth *configuration* does travel — §16 — so a test proving only absence
   * would be satisfied by documents that dropped authentication entirely.
   */
  it('still documents the authentication configuration', async () => {
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
            userFields: [],
          },
        },
      },
    );

    expect((await notesOf(sourceId)).json().markdown).toContain('Mode: ALL_PROTECTED');
    expect((await aiOf(sourceId)).json().context).toContain('Mode: ALL_PROTECTED');
    expect((await blueprintOf(sourceId)).json().authentication.mode).toBe('ALL_PROTECTED');
  });
});

describe('§25: the copy is independently editable', () => {
  it('editing the copy does not touch the source', async () => {
    const blueprint = (await blueprintOf(sourceId)).json();
    const copyId = (await post('/v1/projects/import', { blueprint })).json().id as string;

    const before = (await notesOf(sourceId)).json().markdown;

    const copy = await Project.findById(copyId);
    const ips = copy!.ips as InternalProjectSchema;
    ips.entities[0]!.name = 'EditedInCopy';
    await Project.updateOne({ _id: copyId }, { $set: { ips } });

    expect((await notesOf(copyId)).json().markdown).toContain('EditedInCopy');
    expect((await notesOf(sourceId)).json().markdown).toEqual(before);
  });
});

describe('§25: malformed endpoints', () => {
  /**
   * §25 lists "malformed endpoints rejected" and there is nothing to reject,
   * which is worth recording rather than quietly skipping.
   *
   * Endpoints are not stored. `projectEndpoints` derives them from the entities
   * and `generationConfig.methods`, and Phase 2 deliberately left `ep_`
   * unminted — so a blueprint has no endpoint list that could be malformed, and
   * inventing one would create a second source of truth able to disagree with
   * the entities it came from (which is why §12's "endpoint configuration" is
   * carried as methods and per-entity auth instead).
   *
   * What *is* rejectable is the configuration that decides the endpoint
   * surface, so that is what this asserts.
   */
  it('rejects a blueprint whose method list is not a list', async () => {
    const blueprint = (await blueprintOf(sourceId)).json();
    blueprint.generationConfig.methods = 'GET';

    const response = await post('/v1/projects/import', { blueprint });
    expect(response.statusCode).toBe(422);
    const paths = (response.json().error.details as { path: string }[]).map((d) => d.path);
    expect(paths.some((path) => path.includes('methods'))).toBe(true);
  });

  it('carries no endpoint list to be malformed in the first place', async () => {
    const blueprint = (await blueprintOf(sourceId)).json();

    expect(Object.keys(blueprint)).not.toContain('endpoints');
    // The notes still document endpoints — derived, not stored.
    expect((await notesOf(sourceId)).json().markdown).toContain('## API');
  });
});

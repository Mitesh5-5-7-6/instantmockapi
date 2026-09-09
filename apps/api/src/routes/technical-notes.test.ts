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
import { Project } from '@instantmockapi/db';
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
 * Technical Notes and AI context routes (Phase 4 §10, §24, §26).
 *
 * The documents themselves are tested exhaustively in
 * `packages/generators/docs` — every entity, field, relation and endpoint, the
 * determinism properties, and the no-secrets guarantees. There is no second
 * renderer, so what these tests check is the *route's* contract: what it
 * resolves the definition from, what it refuses, and what it never sends.
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

const notes = (id = projectId, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${id}/technical-notes`,
    headers: authHeader(bearer),
  });

const aiContext = (id = projectId, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${id}/technical-notes/ai`,
    headers: authHeader(bearer),
  });

describe('§10: the notes route', () => {
  it('returns the markdown document', async () => {
    const response = await notes();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['markdown', 'version']);
    expect(body.markdown).toContain('# Shop — Technical Notes');
    expect(body.markdown).toContain('- Name: Shop');
    expect(body.version).toBe(1);
  });

  /**
   * The parsed input, not an empty shell.
   *
   * The JSON adapter wraps a single top-level object as `MainEntity`, so the
   * sample payload's `customer` key becomes a nested *object field* rather than
   * an entity of its own. Both facts have to appear, and the nested leaves are
   * the interesting half — a document that listed only top-level fields would
   * describe a different record shape than the API serves.
   */
  it('documents the entity and its nested fields', async () => {
    const markdown = (await notes()).json().markdown;

    expect(markdown).toMatch(/^### MainEntity$/m);
    expect(markdown).toContain('**customer**');
    for (const leaf of ['name', 'email', 'age']) {
      expect(markdown, leaf).toContain(`**${leaf}**`);
    }
  });

  it('documents the identity field, so the notes match the served API', async () => {
    const markdown = (await notes()).json().markdown;

    expect(markdown).toMatch(/- Identity: `id`/);
    expect(markdown).toContain('**id**');
  });

  /**
   * A definition whose derived fields are absent still documents them.
   *
   * The create path materializes before storing, so `project.ips` normally
   * already carries the identity field and every foreign key — which means the
   * assertion above passes with or without normalisation and proves nothing
   * about it. A definition without them is not hypothetical though: a
   * `Version.ipsSnapshot` taken before relations existed has none, and Stage 8
   * renders exactly those. So the stored document is stripped here to the state
   * a historical one is in, and the route has to re-derive.
   *
   * The failure this guards is a document that omits a field the live API
   * serves — the notes and the API disagreeing about the shape of a record.
   */
  it('re-derives an identity field missing from the stored definition', async () => {
    const project = await Project.findById(projectId);
    const ips = project?.ips as { entities: { fields: { name: string }[] }[] };
    ips.entities[0]!.fields = ips.entities[0]!.fields.filter((field) => field.name !== 'id');
    await Project.updateOne({ _id: projectId }, { $set: { ips } });

    // Stored without it...
    const stored = (await Project.findById(projectId))?.ips as typeof ips;
    expect(stored.entities[0]!.fields.some((field) => field.name === 'id')).toBe(false);

    // ...documented with it.
    expect((await notes()).json().markdown).toContain('**id**');
  });
});

describe('§7: the AI context route', () => {
  it('returns the machine-readable document', async () => {
    const response = await aiContext();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['context', 'version']);
    expect(body.context).toContain('# Project Context');
    expect(body.context).toContain('Name: Shop');
  });

  /**
   * §7 requires output stable across repeated generation. The route adds no
   * clock and no request-scoped value, so two calls a moment apart are the same
   * bytes — which is also what makes the download diffable (§21).
   */
  it('renders byte-identically on two calls', async () => {
    const first = (await aiContext()).json().context;
    const second = (await aiContext()).json().context;

    expect(first).toEqual(second);
  });

  it('renders the human notes byte-identically on two calls too', async () => {
    expect((await notes()).json().markdown).toEqual((await notes()).json().markdown);
  });

  /**
   * A base URL is a fact about a deployment, so it appears only when there is
   * one. A guessed base produces client code that fails against the real API.
   */
  it('omits the base URL until the project is live', async () => {
    expect((await aiContext()).json().context).not.toContain('Base URL:');

    await Project.updateOne(
      { _id: projectId },
      { $set: { 'hosted.url': 'https://api.example.dev/prj_abc/shop' } },
    );

    expect((await aiContext()).json().context).toContain(
      'Base URL: https://api.example.dev/prj_abc/shop',
    );
  });
});

describe('addressing comes from the project, never the snapshot', () => {
  /**
   * `publicId` and `slug` are versionless properties of the project document,
   * and `apps/workers/src/processor.ts` states the rule: a slug edited after a
   * snapshot was taken must not make a document advertise the old path. The
   * stored `project.ips` does not carry either, so without the overlay the
   * document would simply omit the addressing it exists to explain.
   */
  it('documents the current public id and base path', async () => {
    await Project.updateOne(
      { _id: projectId },
      { $set: { publicId: 'prj_abc1234', slug: 'shop' } },
    );

    const markdown = (await notes()).json().markdown;
    expect(markdown).toContain('- Public id: `prj_abc1234`');
    expect(markdown).toContain('- Base path: `shop`');
  });

  it('follows a renamed slug rather than a stale one', async () => {
    await Project.updateOne({ _id: projectId }, { $set: { slug: 'old-shop' } });
    expect((await notes()).json().markdown).toContain('- Base path: `old-shop`');

    await Project.updateOne({ _id: projectId }, { $set: { slug: 'new-shop' } });
    const markdown = (await notes()).json().markdown;

    expect(markdown).toContain('- Base path: `new-shop`');
    expect(markdown).not.toContain('old-shop');
  });
});

describe('§8: mutable facts stay out of the definition', () => {
  /**
   * `generatedAt` exists on `RuntimeFacts` and this route does not set it. A
   * wall-clock stamp would make every export of an unchanged project differ by
   * one line, which breaks both §8's determinism and §21's diff.
   */
  it('stamps no time into either document', async () => {
    const markdown = (await notes()).json().markdown;

    expect(markdown).not.toMatch(/Generated at/);
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect((await aiContext()).json().context).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('reports status and published version under their own heading', async () => {
    const markdown = (await notes()).json().markdown;

    expect(markdown).toContain('## Current state');
    expect(markdown).toContain('- Describes: the project definition');
    // The sentence that tells a reader which half of the document moves.
    expect(markdown).toContain('These facts move on their own');
  });
});

describe('§26/§40: access and secrets', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/technical-notes`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects the AI context unauthenticated too', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/technical-notes/ai`,
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Another user's project is indistinguishable from a missing one — the
   * existing ownership helper's rule, and the reason a 404 rather than a 403 is
   * correct here: a 403 would confirm the project exists.
   */
  it('does not disclose another user’s project', async () => {
    const other = (await login(app, 'intruder@example.com')).accessToken;

    expect((await notes(projectId, other)).statusCode).toBe(404);
    expect((await aiContext(projectId, other)).statusCode).toBe(404);
  });

  it('404s a malformed id rather than failing', async () => {
    expect((await notes('not-an-object-id')).statusCode).toBe(404);
  });

  /**
   * §26 asks for this to be proven at the route, not only in the renderer: the
   * response body is the thing that actually leaves the process, and a future
   * field added to it would not be covered by the generator's own tests.
   */
  it('sends no credential-shaped value in either response', async () => {
    const forbidden = [
      'passwordHash',
      'signingKey',
      'jwtSecret',
      'tokenHash',
      'mongodb://',
      'mongodb+srv://',
      'MockAuthSecret',
      'secret',
    ];
    const bodies = [(await notes()).body, (await aiContext()).body];

    for (const body of bodies) {
      for (const term of forbidden) {
        expect(body.toLowerCase(), term).not.toContain(term.toLowerCase());
      }
    }
  });
});

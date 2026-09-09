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
import { Project, ProjectDraft, Version } from '@instantmockapi/db';
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

/** Either document, for any §20 selection. `undefined` means the default view. */
const query = (version: string | undefined): string =>
  version === undefined ? '' : `?version=${version}`;

const notesFor = (version?: string, id = projectId, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${id}/technical-notes${query(version)}`,
    headers: authHeader(bearer),
  });

const aiFor = (version?: string, id = projectId, bearer = token) =>
  app.inject({
    method: 'GET',
    url: `/v1/projects/${id}/technical-notes/ai${query(version)}`,
    headers: authHeader(bearer),
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
    expect(Object.keys(body).sort()).toEqual(['markdown', 'serving', 'source', 'version']);
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
    expect(Object.keys(body).sort()).toEqual(['context', 'serving', 'source', 'version']);
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

describe('§20: version-aware documentation', () => {
  /** Edit the definition and advance the version, the way a commit does. */
  async function advanceTo(version: number, entityName: string): Promise<void> {
    const project = await Project.findById(projectId);
    const ips = project!.ips as InternalProjectSchema;
    const next = JSON.parse(JSON.stringify(ips)) as InternalProjectSchema;
    next.entities[0]!.name = entityName;
    next.version = version;

    await Version.create({
      projectId,
      version,
      ipsSnapshot: next,
      configSnapshot: project!.generationConfig,
    });
    await Project.updateOne({ _id: projectId }, { $set: { ips: next, currentVersion: version } });
  }

  it('describes a historical version, not the current one', async () => {
    // v1 is the created definition; v2 renames the entity.
    await Version.create({
      projectId,
      version: 1,
      ipsSnapshot: (await Project.findById(projectId))!.ips,
      configSnapshot: (await Project.findById(projectId))!.generationConfig,
    });
    await advanceTo(2, 'RenamedEntity');

    const current = (await notesFor()).json();
    expect(current.version).toBe(2);
    expect(current.markdown).toContain('RenamedEntity');

    const historical = await notesFor('1');
    expect(historical.statusCode, historical.body).toBe(200);
    const body = historical.json();
    expect(body.version).toBe(1);
    expect(body.source).toBe('version');
    expect(body.markdown).toContain('MainEntity');
    expect(body.markdown).not.toContain('RenamedEntity');
  });

  it('describes the draft, not the committed definition', async () => {
    // Open a draft and edit it, without committing.
    const draft = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/draft`,
      headers: authHeader(token),
    });
    // 201: the project has no draft, so this forks one. An existing draft comes
    // back 200 — `POST /draft` is idempotent by contract.
    expect(draft.statusCode, draft.body).toBe(201);

    const stored = await ProjectDraft.findOne({ projectId });
    const ips = stored!.ips as InternalProjectSchema;
    ips.entities[0]!.name = 'DraftOnlyEntity';
    await ProjectDraft.updateOne({ projectId }, { $set: { ips } });

    const body = (await notesFor('draft')).json();
    expect(body.source).toBe('draft');
    expect(body.markdown).toContain('DraftOnlyEntity');
    expect(body.markdown).toContain('Describes: the draft definition');

    // The current view is unaffected by an uncommitted draft.
    expect((await notesFor()).json().markdown).not.toContain('DraftOnlyEntity');
  });

  it('404s a draft view when no draft is open', async () => {
    const response = await notesFor('draft');
    expect(response.statusCode).toBe(404);
  });

  it('describes the published version when asked for it', async () => {
    await Version.create({
      projectId,
      version: 1,
      ipsSnapshot: (await Project.findById(projectId))!.ips,
      configSnapshot: (await Project.findById(projectId))!.generationConfig,
    });
    await advanceTo(2, 'NewerEntity');
    // v1 is live; the definition has moved to v2.
    await Project.updateOne(
      { _id: projectId },
      { $set: { publishedVersion: 1, 'hosted.url': 'https://api.example.dev/prj_abc/shop' } },
    );

    const body = (await notesFor('published')).json();
    expect(body.version).toBe(1);
    expect(body.serving).toBe(true);
    expect(body.markdown).toContain('MainEntity');
    expect(body.markdown).not.toContain('NewerEntity');
  });

  it('404s a version that was never snapshotted, with the reason', async () => {
    const response = await notesFor('7');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain('never snapshotted');
  });

  it.each([
    ['a word', 'latest'],
    ['zero', '0'],
    ['a negative', '-2'],
    ['a decimal', '1.5'],
  ])('rejects %s as a version', async (_label, raw) => {
    const response = await notesFor(raw);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details[0].path).toBe('version');
  });

  it('applies the same selection to the AI context', async () => {
    await Version.create({
      projectId,
      version: 1,
      ipsSnapshot: (await Project.findById(projectId))!.ips,
      configSnapshot: (await Project.findById(projectId))!.generationConfig,
    });
    await advanceTo(2, 'RenamedEntity');

    const body = (await aiFor('1')).json();
    expect(body.version).toBe(1);
    expect(body.context).toContain('MainEntity');
    expect(body.context).not.toContain('RenamedEntity');
  });
});

describe('§20: draft configuration is never combined with published runtime state', () => {
  /**
   * The rule §20 states, and the one line that can break it.
   *
   * A hosted URL printed beside a definition that URL does not serve invites a
   * reader to conclude it does — and a developer who writes client code against
   * a draft's field list and the published URL gets 422s they cannot explain.
   * So the URL appears only when the documented definition is the served one.
   */
  async function goLive(): Promise<void> {
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          status: 'active',
          publishedVersion: 1,
          'hosted.url': 'https://api.example.dev/prj_abc/shop',
        },
      },
    );
  }

  it('prints the hosted URL on the definition that is served', async () => {
    await goLive();
    const body = (await notesFor()).json();

    expect(body.serving).toBe(true);
    expect(body.markdown).toContain('Hosted URL: https://api.example.dev/prj_abc/shop');
    expect(body.markdown).toContain('This is the definition the hosted API serves.');
  });

  it('withholds it from a draft, and says which version is live instead', async () => {
    await goLive();
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/draft`,
      headers: authHeader(token),
    });

    const body = (await notesFor('draft')).json();

    expect(body.serving).toBe(false);
    expect(body.markdown).not.toContain('https://api.example.dev');
    expect(body.markdown).toContain('Not served.');
  });

  it('withholds it from a historical version', async () => {
    await Version.create({
      projectId,
      version: 1,
      ipsSnapshot: (await Project.findById(projectId))!.ips,
      configSnapshot: (await Project.findById(projectId))!.generationConfig,
    });
    const project = await Project.findById(projectId);
    const next = JSON.parse(JSON.stringify(project!.ips)) as InternalProjectSchema;
    next.version = 2;
    await Version.create({
      projectId,
      version: 2,
      ipsSnapshot: next,
      configSnapshot: project!.generationConfig,
    });
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          ips: next,
          currentVersion: 2,
          publishedVersion: 2,
          'hosted.url': 'https://api.example.dev/prj_abc/shop',
        },
      },
    );

    const body = (await notesFor('1')).json();

    expect(body.serving).toBe(false);
    expect(body.markdown).not.toContain('https://api.example.dev');
    expect(body.markdown).toContain('The hosted API serves v2');
  });

  /**
   * The AI context is the more dangerous of the two documents here: it exists
   * to be pasted into a code generator, so a base URL beside the wrong field
   * list produces code that fails against the real API.
   */
  it('gives the AI context no base URL for a draft', async () => {
    await goLive();
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/draft`,
      headers: authHeader(token),
    });

    expect((await aiFor('draft')).json().context).not.toContain('Base URL');
    // ...and does give it for the served definition, so the absence above is a
    // decision rather than a feature that never worked.
    expect((await aiFor()).json().context).toContain('Base URL');
  });

  /**
   * Nothing deployed: the document must not name a "published version" at all.
   *
   * `publishedVersionOf` falls back to `currentVersion`, so the pointer always
   * holds a number — reporting it would tell a reader that v1 is live when no
   * hosted URL exists. `hosted.url` is the only honest test.
   */
  it('names no published version when nothing is live', async () => {
    const body = (await notesFor()).json();

    expect(body.serving).toBe(false);
    expect(body.markdown).not.toContain('Published version:');
    expect(body.markdown).toContain('Nothing is published yet');
  });
});

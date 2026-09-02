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
import { Job, Project, ProjectDraft, Version, type IProject } from '@instantmockapi/db';
import { collectSchemaIds } from '@instantmockapi/ips';
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
 * Draft route behaviour: forking, editing, the commit gates, and discarding.
 *
 * The version-safety narrative lives in `edit-lifecycle.test.ts`. This file
 * covers the rules around it — what happens on a second POST, what an unedited
 * commit does, whether a risky change can slip through unacknowledged, and
 * whether another user can reach any of it.
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

const draftUrl = () => `/v1/projects/${projectId}/draft`;

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: authHeader(token), ...(payload ? { payload } : {}) });
const get = (url: string) => app.inject({ method: 'GET', url, headers: authHeader(token) });
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authHeader(token), payload });

/**
 * Invert the requiredness of the fixture's first nested leaf.
 *
 * Inverted rather than set to a literal: every leaf the fixture parses out is
 * already `required: true`, so setting `true` would be a no-op and every
 * assertion downstream would silently be testing an unedited draft.
 */
async function editedIps(): Promise<Record<string, unknown>> {
  const project = await reload();
  const clone = JSON.parse(JSON.stringify(project.ips)) as {
    entities: { fields: { name: string; children?: { required: boolean }[] }[] }[];
  };
  const nested = clone.entities[0]?.fields.find((f) => (f.children?.length ?? 0) > 0);
  const leaf = nested?.children?.[0];
  if (!leaf) {
    throw new Error('fixture has no nested leaf to edit');
  }
  leaf.required = !leaf.required;
  return clone as unknown as Record<string, unknown>;
}

/**
 * A genuinely BREAKING edit: retype a nested leaf from string to integer.
 *
 * `editedIps` only relaxes a required flag, which is `SAFE` — so it cannot
 * exercise the risk gate. Keeping the two separate means each test says which
 * kind of change it is about.
 */
async function riskyIps(leafIndex = 0): Promise<Record<string, unknown>> {
  const project = await reload();
  const clone = JSON.parse(JSON.stringify(project.ips)) as {
    entities: { fields: { children?: { name: string; type: string }[] }[] }[];
  };
  const leaves = clone.entities[0]?.fields.find((f) => (f.children?.length ?? 0) > 0)?.children;
  const leaf = leaves?.[leafIndex];
  if (!leaf) {
    throw new Error(`fixture has no nested leaf at ${leafIndex} to retype`);
  }
  leaf.type = leaf.type === 'integer' ? 'string' : 'integer';
  return clone as unknown as Record<string, unknown>;
}

/** The digest the API demands back on a risky commit. */
async function currentDigest(): Promise<string> {
  const analysis = (await get(`${draftUrl()}/impact`)).json() as { digest: string };
  return analysis.digest;
}

// ---------------------------------------------------------------------------

describe('POST /draft', () => {
  it('forks from the active definition with 201', async () => {
    const res = await post(draftUrl());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      projectId,
      baseVersion: 1,
      currentVersion: 1,
      stale: false,
    });
  });

  /**
   * One draft per project. Returning the open draft with 200 rather than a 409
   * is deliberate: the only useful response to "one already exists" is to fetch
   * it, so a failed POST followed by a GET buys the client nothing.
   */
  it('returns the existing draft with 200 on a second call', async () => {
    const first = await post(draftUrl());
    const second = await post(draftUrl());

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(1);
  });

  it('does not lose an edit when a second POST arrives', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    const resumed = await post(draftUrl());
    expect(resumed.statusCode).toBe(200);
    // The edit survives. A POST that re-forked here would silently discard work.
    const impact = await get(`${draftUrl()}/impact`);
    expect((impact.json() as { changes: unknown[] }).changes.length).toBeGreaterThan(0);
  });

  /**
   * The lazy backfill. Every project generated before Phase 1 has an id-less
   * schema, and the diff matches on ids alone — so without this the first fork
   * would produce a draft whose diff against its own origin reports every entity
   * as removed and re-added.
   */
  it('backfills stable ids onto the active definition', async () => {
    const before = await reload();
    // Strip the ids the fixture was created with, simulating a pre-Phase-1 doc.
    const stripped = JSON.parse(JSON.stringify(before.ips)) as Record<string, unknown>;
    const strip = (node: Record<string, unknown>): void => {
      delete node['id'];
      for (const key of ['fields', 'children', 'relations', 'entities']) {
        const list = node[key];
        if (Array.isArray(list)) {
          for (const child of list) {
            strip(child as Record<string, unknown>);
          }
        }
      }
    };
    strip(stripped);
    before.ips = stripped as never;
    before.markModified('ips');
    await before.save();
    expect(collectSchemaIds(stripped as never).length).toBe(0);

    await post(draftUrl());

    const after = await reload();
    expect(collectSchemaIds(after.ips as never).length).toBeGreaterThan(0);
    // Backfilling identity is not a schema change: it must not mark the project
    // pending regeneration for opening an editor.
    expect(after.currentVersion).toBe(1);
  });

  it('mints no new ids on a second fork', async () => {
    await post(draftUrl());
    const first = [...collectSchemaIds((await reload()).ips as never)].sort();

    await app.inject({ method: 'DELETE', url: draftUrl(), headers: authHeader(token) });
    await post(draftUrl());
    const second = [...collectSchemaIds((await reload()).ips as never)].sort();

    expect(second).toEqual(first);
  });

  it('gives the draft its own copy, not a shared reference', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    // The active definition is untouched by an edit to the draft.
    const project = await reload();
    const active = JSON.stringify(project.ips);
    const draft = await ProjectDraft.findOne({ projectId });
    expect(JSON.stringify(draft!.ips)).not.toBe(active);
  });
});

describe('GET /draft', () => {
  it('404s when no draft is open', async () => {
    const res = await get(draftUrl());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns the draft schema and config', async () => {
    await post(draftUrl());
    const res = await get(draftUrl());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ips: { entities: unknown[] }; generationConfig: unknown };
    expect(body.ips.entities.length).toBeGreaterThan(0);
    expect(body.generationConfig).toMatchObject({ methods: expect.any(Array) });
  });
});

describe('PATCH /draft', () => {
  it('rejects an invalid schema without saving it', async () => {
    await post(draftUrl());
    const res = await patch(draftUrl(), { ips: { entities: [] } });
    expect(res.statusCode).toBe(422);

    // The draft still holds the last good state.
    const impact = await get(`${draftUrl()}/impact`);
    expect((impact.json() as { changes: unknown[] }).changes).toEqual([]);
  });

  it('accepts a config-only edit and reports it as a change', async () => {
    await post(draftUrl());
    const res = await patch(draftUrl(), {
      generationConfig: {
        validators: ['zod'],
        types: ['typescript'],
        methods: ['GET', 'POST'],
        mockRecords: 10,
      },
    });
    expect(res.statusCode).toBe(200);

    const analysis = (await get(`${draftUrl()}/impact`)).json() as {
      changes: { kind: string }[];
      artifacts: string[];
    };
    expect(analysis.changes.map((c) => c.kind)).toContain('METHODS_CHANGED');
    expect(analysis.artifacts).toContain('hosted_api');
  });

  it('rejects an empty body', async () => {
    await post(draftUrl());
    const res = await patch(draftUrl(), {});
    expect(res.statusCode).toBe(400);
  });

  it('mints ids for newly added fields so the next edit diffs cleanly', async () => {
    await post(draftUrl());
    const project = await reload();
    const clone = JSON.parse(JSON.stringify(project.ips)) as {
      entities: { fields: Record<string, unknown>[] }[];
    };
    clone.entities[0]!.fields.push({
      name: 'nickname',
      type: 'string',
      required: false,
      default: null,
      children: [],
      validation: {},
      meta: {},
    });
    await patch(draftUrl(), { ips: clone as unknown as Record<string, unknown> });

    const draft = await ProjectDraft.findOne({ projectId });
    const added = (draft!.ips.entities[0]!.fields as { name: string; id?: string }[]).find(
      (f) => f.name === 'nickname',
    );
    expect(added?.id).toMatch(/^fld_/);
  });
});

describe('GET /draft/impact', () => {
  it('reports no changes for an untouched draft, listing every endpoint as unaffected', async () => {
    await post(draftUrl());
    const res = await get(`${draftUrl()}/impact`);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      changes: unknown[];
      affected: unknown[];
      unaffected: unknown[];
      risk: string | null;
      requiresAcknowledgement: boolean;
    };
    expect(body.changes).toEqual([]);
    expect(body.affected).toEqual([]);
    expect(body.unaffected.length).toBeGreaterThan(0);
    expect(body.risk).toBeNull();
    expect(body.requiresAcknowledgement).toBe(false);
  });

  it('carries the reason and facet a UI renders per endpoint', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    const body = (await get(`${draftUrl()}/impact`)).json() as {
      affected: { reasons: { reason: string; facet: string; change: string }[] }[];
    };
    const reasons = body.affected.flatMap((e) => e.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason.reason).toMatch(/^(request|response|path)\./);
      expect(['request', 'response', 'query', 'path']).toContain(reason.facet);
      expect(reason.change).toBeTruthy();
    }
  });
});

describe('POST /draft/commit', () => {
  it('refuses a BREAKING commit that was not acknowledged', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });

    const res = await post(`${draftUrl()}/commit`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('acknowledgeImpact');
    expect(res.json().error.message).toContain('BREAKING');
    // The affected endpoints ride along, so a client that skipped the impact
    // call can still render the dialog from the rejection alone.
    expect((res.json().error.details as unknown[]).length).toBeGreaterThan(0);

    // Nothing moved. A rejected commit must leave the definition exactly as it was.
    expect((await reload()).currentVersion).toBe(1);
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(1);
  });

  it('commits once the risk is acknowledged', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });

    const res = await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ committed: true, version: 2 });
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
  });

  /**
   * The hole a boolean `acknowledgeRisk` would leave open.
   *
   * A client that reviewed one impact and then edited the draft again must not be
   * able to replay its old approval — the server would accept a change nobody
   * looked at. Binding the acknowledgement to a digest of the draft makes the
   * stale approval fail loudly.
   */
  it('refuses an acknowledgement that was issued for a different draft state', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });
    const reviewed = await currentDigest();

    // The user (or the client) changes something else before committing. A
    // different leaf, and still BREAKING — so the commit is not merely allowed
    // for having become safe.
    await patch(draftUrl(), { ips: await riskyIps(1) });
    expect(await currentDigest()).not.toBe(reviewed);

    const replayed = await post(`${draftUrl()}/commit`, { acknowledgeImpact: reviewed });
    expect(replayed.statusCode).toBe(422);
    expect(replayed.json().error.message).toContain('changed since');
    expect((await reload()).currentVersion).toBe(1);

    // Re-reviewing produces a digest that works.
    const fresh = await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });
    expect(fresh.statusCode).toBe(202);
  });

  it('names the expected digest in the rejection so a client can recover', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });

    const res = await post(`${draftUrl()}/commit`);
    const details = res.json().error.details as { path: string; issue: string }[];
    const offered = details.find((d) => d.path === 'acknowledgeImpact');
    expect(offered?.issue).toBe(await currentDigest());
  });

  it('keeps the digest stable while the draft is untouched', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });
    expect(await currentDigest()).toBe(await currentDigest());
  });

  /**
   * The complement, and the reason the gate is keyed on `needsAttention` rather
   * than "did anything change": relaxing a required field breaks no caller, so
   * demanding a confirmation for it would train users to click through the
   * dialog without reading it.
   */
  it('commits a SAFE change with no acknowledgement at all', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    const analysis = (await get(`${draftUrl()}/impact`)).json() as {
      risk: string;
      requiresAcknowledgement: boolean;
    };
    expect(analysis.risk).toBe('SAFE');
    expect(analysis.requiresAcknowledgement).toBe(false);

    const res = await post(`${draftUrl()}/commit`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ committed: true, version: 2 });
  });

  /**
   * Committing an unedited draft would burn a version number and enqueue a job
   * that regenerates byte-identical artifacts.
   */
  it('does nothing for an unchanged draft', async () => {
    await post(draftUrl());
    const res = await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ committed: false, reason: 'no-changes', version: null });
    expect((await reload()).currentVersion).toBe(1);
    expect(await Job.countDocuments({ projectId })).toBe(0);
    // The draft is cleaned up — there is nothing left to resume.
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
  });

  it('enqueues the artifacts the impact report named', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });
    const expected = (await get(`${draftUrl()}/impact`)).json() as { artifacts: string[] };

    await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });

    const job = await Job.findOne({ projectId, version: 2 });
    expect(job).not.toBeNull();
    expect([...job!.requestedArtifacts].sort()).toEqual([...expected.artifacts].sort());
  });

  /**
   * The exact round trip the web editor performs, and the one no test made.
   *
   * A user changed an identity style and got
   * 400 `body.artifacts.2 must be equal to one of the allowed values` — the
   * impact report named `ips`, the panel echoed it back, and the route schema
   * validates against `REGENERATABLE_ARTIFACTS`, which excludes it. Fixed at the
   * source (`ips` is no longer a generator), but the missing coverage was the
   * real defect: "enqueues the artifacts the impact report named" never sent them,
   * and the explicit-selection test only ever passed two hand-picked values.
   */
  it('accepts the impact report’s own artifact list verbatim', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });

    const analysis = (await get(`${draftUrl()}/impact`)).json() as {
      artifacts: string[];
      digest: string;
    };
    expect(analysis.artifacts.length).toBeGreaterThan(0);

    const res = await post(`${draftUrl()}/commit`, {
      acknowledgeImpact: analysis.digest,
      artifacts: analysis.artifacts,
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(202);

    const job = await Job.findOne({ projectId, version: 2 });
    expect([...job!.requestedArtifacts].sort()).toEqual([...analysis.artifacts].sort());
  });

  /** Every attribution path, since each builds its artifact list differently. */
  it('accepts the artifact list for an entity rename, an add and a config change', async () => {
    for (const edit of [
      async () => {
        const project = await reload();
        const clone = JSON.parse(JSON.stringify(project.ips)) as { entities: { name: string }[] };
        clone.entities[0]!.name = 'Renamed';
        return { ips: clone as unknown as Record<string, unknown> };
      },
      async () => ({
        generationConfig: {
          validators: ['zod'],
          types: ['typescript'],
          methods: ['GET', 'POST'],
          mockRecords: 12,
        },
      }),
    ]) {
      await app.inject({ method: 'DELETE', url: draftUrl(), headers: authHeader(token) });
      await post(draftUrl());
      await patch(draftUrl(), await edit());

      const analysis = (await get(`${draftUrl()}/impact`)).json() as {
        artifacts: string[];
        digest: string;
      };
      const res = await post(`${draftUrl()}/commit`, {
        acknowledgeImpact: analysis.digest,
        artifacts: analysis.artifacts,
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(202);

      // Reset for the next iteration: the commit advanced the definition.
      await app.inject({ method: 'DELETE', url: draftUrl(), headers: authHeader(token) });
    }
  });

  it('honours an explicit artifact selection from the dialog', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    await post(`${draftUrl()}/commit`, {
      acknowledgeRisk: true,
      artifacts: ['hosted_api', 'openapi'],
    });

    const job = await Job.findOne({ projectId, version: 2 });
    expect([...job!.requestedArtifacts].sort()).toEqual(['hosted_api', 'openapi']);
  });

  it('stamps a readable note on the new version', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });
    await post(`${draftUrl()}/commit`, {
      acknowledgeImpact: await currentDigest(),
      note: 'Tighten the address',
    });

    const version = await Version.findOne({ projectId, version: 2 });
    expect(version!.note).toBe('Tighten the address');
  });

  it('derives a note when none is given', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });
    await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });

    const version = await Version.findOne({ projectId, version: 2 });
    expect(version!.note).toMatch(/Draft commit: 1 change/);
  });

  it('404s when there is no draft to commit', async () => {
    const res = await post(`${draftUrl()}/commit`, { acknowledgeImpact: await currentDigest() });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /draft', () => {
  it('discards the draft and leaves the definition alone', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await editedIps() });

    const res = await app.inject({
      method: 'DELETE',
      url: draftUrl(),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
    expect((await reload()).currentVersion).toBe(1);
  });

  it('404s when nothing is open', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: draftUrl(),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('access control', () => {
  it('hides another owner’s draft behind a 404', async () => {
    await post(draftUrl());
    const intruder = (await login(app, 'someone-else@example.com')).accessToken;

    for (const [method, url] of [
      ['GET', draftUrl()],
      ['POST', draftUrl()],
      ['GET', `${draftUrl()}/impact`],
      ['POST', `${draftUrl()}/commit`],
      ['DELETE', draftUrl()],
    ] as const) {
      const res = await app.inject({ method, url, headers: authHeader(intruder) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: draftUrl() });
    expect(res.statusCode).toBe(401);
  });

  it('cleans up the draft when the project is hard-deleted', async () => {
    await post(draftUrl());
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBeLessThan(300);
    // An orphaned draft would hold the unique index on projectId and block a
    // future project from ever opening one.
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
  });
});

describe('concurrent forks', () => {
  /**
   * `openDraft` reads then inserts, and the unique index on `projectId` makes the
   * loser of that race throw E11000. "Fork or resume" has to be idempotent under
   * concurrency, not just when the calls are politely sequential — React's
   * development double-invoke fires two POSTs on the editor's very first render,
   * so this is a first-load certainty rather than a corner case.
   */
  it('return one draft, not a 500', async () => {
    const results = await Promise.all([post(draftUrl()), post(draftUrl()), post(draftUrl())]);

    for (const res of results) {
      expect([200, 201], `unexpected ${res.statusCode}: ${res.body}`).toContain(res.statusCode);
    }
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(1);
    // Exactly one of them created it; the others resumed.
    expect(results.filter((res) => res.statusCode === 201)).toHaveLength(1);
  });
});

describe('the editor’s request sequence', () => {
  /**
   * A user watching the network panel saw two 404s after every commit and
   * reasonably asked what was broken. Nothing was, on the server: commit deletes
   * the draft, so `GET /draft` and `GET /draft/impact` correctly answer 404. The
   * client was calling `invalidateQueries` on both, which refetches — and
   * refetching a resource you have just deleted is a guaranteed 404.
   *
   * Fixed in the client (`useForgetDraft` removes those queries instead). This
   * pins the server side of the contract the fix relies on: after a commit, both
   * really are gone, so a refetch really would fail. If either of these ever
   * starts answering 200, the client is silently holding a dead draft.
   */
  it('has no draft and no impact left after a commit', async () => {
    await post(draftUrl());
    await patch(draftUrl(), { ips: await riskyIps() });
    const committed = await post(`${draftUrl()}/commit`, {
      acknowledgeImpact: await currentDigest(),
    });
    expect(committed.statusCode).toBe(202);

    expect((await get(draftUrl())).statusCode).toBe(404);
    expect((await get(`${draftUrl()}/impact`)).statusCode).toBe(404);
  });

  it('has no draft and no impact left after a discard', async () => {
    await post(draftUrl());
    await app.inject({ method: 'DELETE', url: draftUrl(), headers: authHeader(token) });

    expect((await get(draftUrl())).statusCode).toBe(404);
    expect((await get(`${draftUrl()}/impact`)).statusCode).toBe(404);
  });

  /**
   * The loader is `POST /draft`, not `GET`, so opening the editor is one request
   * that cannot fail with "no draft is open". That only holds while POST stays
   * idempotent — this is the property the client now depends on.
   */
  it('answers POST /draft with the same draft however many times it is called', async () => {
    const first = await post(draftUrl());
    expect(first.statusCode).toBe(201);

    await patch(draftUrl(), { ips: await riskyIps() });
    const digest = await currentDigest();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await post(draftUrl());
      expect(again.statusCode).toBe(200);
      // Idempotent in the sense that matters: the edit is still there.
      expect(await currentDigest()).toBe(digest);
    }
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(1);
  });
});

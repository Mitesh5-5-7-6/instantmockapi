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
 * Rollback through the normal pipeline (Phase 2 §22, §16, §23).
 *
 * `restore` used to write the live definition and bump the version — so the one
 * action most likely to remove fields and break callers was the only one that
 * skipped the review every ordinary edit goes through. It now seeds the draft:
 *
 *     restore ─▶ draft ─▶ diff ─▶ impact ─▶ review ─▶ commit ─▶ generate ─▶ publish
 *
 * Which means the breaking-change gate, the acknowledgement digest, selective
 * regeneration and the staleness check all apply to a rollback for free — and
 * §16's "rollback must not change publishedVersionId" holds because nothing in
 * the restore path goes near it.
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

const history = () => get(`/v1/projects/${projectId}/versions`);
const restore = (version: number) => post(`/v1/projects/${projectId}/versions/${version}/restore`);

/** The fixture's editable leaf — the parser nests scalars under an object field. */
function leaf(ips: InternalProjectSchema, name: string) {
  const nested = ips.entities[0]!.fields.find((field) => (field.children?.length ?? 0) > 0);
  const found = nested?.children.find((child) => child.name === name);
  if (!found) {
    throw new Error(`fixture has no nested leaf named ${name}`);
  }
  return found;
}

/** Edit the live definition, advancing the version. */
async function edit(mutate: (ips: InternalProjectSchema) => void): Promise<number> {
  const project = await reload();
  const clone = JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema;
  mutate(clone);
  const response = await patch(`/v1/projects/${projectId}`, {
    ips: clone as unknown as Record<string, unknown>,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (await reload()).currentVersion;
}

/** Commit the open draft, acknowledging whatever it reports. */
async function commit(artifacts?: string[]) {
  const digest = (
    (await get(`/v1/projects/${projectId}/draft/impact`)).json() as { digest: string }
  ).digest;
  return post(`/v1/projects/${projectId}/draft/commit`, {
    acknowledgeImpact: digest,
    ...(artifacts ? { artifacts } : {}),
  });
}

/** v1 snapshotted, then a field removed so rolling back would restore it. */
async function removeAFieldAfterSnapshot(): Promise<void> {
  await history();
  await edit((ips) => {
    const nested = ips.entities[0]!.fields.find((field) => (field.children?.length ?? 0) > 0)!;
    nested.children = nested.children.filter((child) => child.name !== 'age');
  });
}

describe('restore seeds the draft', () => {
  it('does not touch the live definition or the published version', async () => {
    // §16, and the whole reason this moved: the live API keeps serving until a
    // reviewed commit says otherwise.
    await removeAFieldAfterSnapshot();
    const before = await reload();

    const response = await restore(1);
    expect(response.statusCode, response.body).toBe(200);

    const after = await reload();
    expect(after.currentVersion).toBe(before.currentVersion);
    expect(after.publishedVersion).toBe(before.publishedVersion);
    expect(JSON.stringify(after.ips)).toBe(JSON.stringify(before.ips));
  });

  it('returns the draft and its impact, so the client can review immediately', async () => {
    await removeAFieldAfterSnapshot();
    const body = (await restore(1)).json();

    expect(body.rollbackSourceVersion).toBe(1);
    expect(body.analysis).toBeDefined();
    // Rolling back restores the removed field, which the diff reports as an
    // addition rather than as a mysterious replacement.
    expect(
      body.analysis.changes.some((change: { kind: string }) => change.kind === 'FIELD_ADDED'),
    ).toBe(true);
  });

  it('records where the definition came from, on the draft', async () => {
    await removeAFieldAfterSnapshot();
    await restore(1);

    const draft = await ProjectDraft.findOne({ projectId });
    expect(draft?.rollbackSourceVersion).toBe(1);
  });

  it('takes over an open draft rather than refusing', async () => {
    // One draft per project, so a rollback has to claim it. Refusing while
    // unsaved edits exist would leave the user unable to roll back without
    // discarding by hand; merging the two would be worse, because the
    // snapshot's definition is the point of the operation.
    await removeAFieldAfterSnapshot();
    expect((await post(`/v1/projects/${projectId}/draft`)).statusCode).toBe(201);
    await patch(`/v1/projects/${projectId}/draft`, {
      ips: JSON.parse(JSON.stringify((await reload()).ips)) as Record<string, unknown>,
    });

    expect((await restore(1)).statusCode).toBe(200);
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(1);
    expect((await ProjectDraft.findOne({ projectId }))?.rollbackSourceVersion).toBe(1);
  });

  it('still refuses a version that was never authored', async () => {
    await history();
    expect((await restore(99)).statusCode).toBe(404);
  });
});

describe('the rollback commits through the normal pipeline', () => {
  it('creates a new version rather than rewinding to the old one', async () => {
    // §7: never reuse a version number, never mutate history. Rolling v2 back to
    // v1's definition produces v3.
    await removeAFieldAfterSnapshot();
    await restore(1);

    const response = await commit();
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().version).toBe(3);

    // v1 and v2 are untouched.
    expect(await Version.countDocuments({ projectId, version: 1 })).toBe(1);
    expect(await Version.countDocuments({ projectId, version: 2 })).toBe(1);
  });

  it('stamps the new version as a rollback, naming its source', async () => {
    await removeAFieldAfterSnapshot();
    await restore(1);
    await commit();

    const rows = (await history()).json().data as {
      version: number;
      changeType: string;
      rollbackSourceVersion: number | null;
      note: string | null;
    }[];
    const newest = rows.find((row) => row.version === 3)!;

    expect(newest.changeType).toBe('ROLLBACK');
    expect(newest.rollbackSourceVersion).toBe(1);
    // And says so in words, for the history list.
    expect(newest.note).toContain('Rollback to v1');
  });

  it('leaves the published version alone until an explicit publish', async () => {
    // §16 again, on the far side of the commit: generation does not publish, so
    // a rollback cannot go live by itself either.
    await removeAFieldAfterSnapshot();
    const before = await reload();
    await restore(1);
    await commit();

    expect((await reload()).publishedVersion).toBe(before.publishedVersion);
  });

  it('applies the same acknowledgement gate as any other edit', async () => {
    // A rollback that removes fields is breaking, and §23 wants explicit
    // confirmation. It gets the existing digest gate for free — no separate
    // rollback confirmation path to keep in step.
    await history();
    await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });
    await restore(1);

    const unacknowledged = await post(`/v1/projects/${projectId}/draft/commit`, {});
    expect(unacknowledged.statusCode).toBe(422);

    expect((await commit()).statusCode).toBe(202);
  });

  it('discards the draft once committed, so nothing is left to resume', async () => {
    await removeAFieldAfterSnapshot();
    await restore(1);
    await commit();

    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
  });
});

describe('mock data is forced on a schema-affecting rollback', () => {
  /**
   * `MockStore` is keyed `(projectId, entity)` with **no version**.
   *
   * So the records on disk were seeded for the newer schema by definition, and
   * rolling the definition back without reseeding leaves the live API returning
   * fields the restored schema does not declare and missing ones it does. The
   * promotion policy already calls this `staleDataRisk`; a rollback turns it
   * from a possibility into a certainty.
   *
   * It is also the one inconsistency a user cannot see: the schema page, the
   * docs and the types would all agree with each other and disagree with the
   * data.
   */
  it('adds mock_data even when the caller did not select it', async () => {
    await removeAFieldAfterSnapshot();
    await restore(1);

    // Deliberately omitting mock_data, which §17 normally allows.
    const response = await commit(['hosted_api', 'openapi']);
    expect(response.statusCode, response.body).toBe(202);

    const job = await Job.findById(response.json().job.jobId);
    expect(job?.requestedArtifacts).toContain('mock_data');
  });

  it('does not duplicate it when the caller already selected it', async () => {
    await removeAFieldAfterSnapshot();
    await restore(1);

    const response = await commit(['hosted_api', 'mock_data']);
    const job = await Job.findById(response.json().job.jobId);

    expect(job?.requestedArtifacts.filter((a) => a === 'mock_data')).toHaveLength(1);
  });

  it('leaves an ordinary edit’s selection alone', async () => {
    // The forcing is specific to a rollback. An ordinary edit keeps §17's full
    // freedom to deselect, because its records were seeded for a schema that is
    // moving forward rather than backward.
    await history();
    await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });
    expect((await post(`/v1/projects/${projectId}/draft`)).statusCode).toBe(201);
    await patch(`/v1/projects/${projectId}/draft`, {
      ips: JSON.parse(JSON.stringify((await reload()).ips)) as Record<string, unknown>,
    });
    await edit((ips) => {
      leaf(ips, 'age').type = 'integer';
    });

    // Fresh draft against the current definition, with a real change.
    await post(`/v1/projects/${projectId}/draft/refork`);
    const project = await reload();
    const edited = JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema;
    leaf(edited, 'name').required = !leaf(edited, 'name').required;
    await patch(`/v1/projects/${projectId}/draft`, {
      ips: edited as unknown as Record<string, unknown>,
    });

    const response = await commit(['hosted_api', 'openapi']);
    expect(response.statusCode, response.body).toBe(202);
    const job = await Job.findById(response.json().job.jobId);
    expect(job?.requestedArtifacts).not.toContain('mock_data');
  });

  it('does not force it for a rollback that changes no record shape', async () => {
    // Rolling back a config-only difference cannot invalidate a stored record,
    // so the forcing would be noise — and would reseed data for no reason.
    await history();
    await patch(`/v1/projects/${projectId}`, {
      generationConfig: {
        ...(await reload()).generationConfig,
        mockRecords: 7,
      },
    });
    await restore(1);

    const response = await commit(['hosted_api']);
    expect(response.statusCode, response.body).toBe(202);
    const job = await Job.findById(response.json().job.jobId);
    // `mockRecords` itself changed, so `mock_data` may legitimately be in the
    // impact set — what must NOT happen is the rollback forcing it in when the
    // caller pruned it and no shape moved.
    expect(job?.requestedArtifacts).toEqual(['hosted_api']);
  });
});

describe('authorization', () => {
  it('does not let another user roll back this project', async () => {
    await removeAFieldAfterSnapshot();
    const intruder = (await login(app, 'intruder@example.com')).accessToken;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/1/restore`,
      headers: authHeader(intruder),
    });
    expect(response.statusCode).toBe(404);
    expect(await ProjectDraft.countDocuments({ projectId })).toBe(0);
  });
});

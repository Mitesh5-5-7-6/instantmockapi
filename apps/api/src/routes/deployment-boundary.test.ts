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
import { Project, Version, hasPendingRegeneration, publishedVersionOf } from '@instantmockapi/db';
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
 * The editing/deployment boundary (Phase 1).
 *
 * Three routes used to advance `currentVersion` while writing no artifacts —
 * `PATCH` with a schema, `restore`, and a partial `regenerate`. Because the mock
 * runtime resolved its `hosted_api` artifact *for* `currentVersion`, each of them
 * pointed the live URL at a version that did not exist. `restore` was the worst:
 * its own comment says it writes no artifacts, so restoring a snapshot took the
 * API down, with no job queued and no way back.
 *
 * These assert the routes now **pin** the published version before bumping. The
 * pin is what protects a project created before the split: `publishedVersionOf`
 * falls back to `currentVersion`, and a fallback follows the field it falls back
 * to — so without pinning, the very first edit would drag the runtime forward
 * again.
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

/**
 * A schema edit that actually validates.
 *
 * `entities: []` is rejected with a 422 — an IPS must describe at least one
 * entity — so the edit flips a real field on a real entity instead. That is also
 * closer to the case Phase 1 exists for: a user correcting one mistake.
 */
function editedIps(ips: Record<string, unknown>, required: boolean): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(ips)) as {
    entities: { fields: { required: boolean }[] }[];
  };
  const first = clone.entities[0]?.fields[0];
  if (!first) {
    throw new Error('fixture project has no editable field');
  }
  first.required = required;
  return clone as unknown as Record<string, unknown>;
}

describe('a new project', () => {
  it('has no published version until something is generated', async () => {
    const project = await reload();
    expect(project.publishedVersion ?? null).toBeNull();
    // ...and therefore reports nothing pending, rather than flagging every
    // brand-new project as stale.
    expect(hasPendingRegeneration(project)).toBe(false);
  });
});

describe('PATCH /v1/projects/:id with a schema', () => {
  it('pins the published version before advancing the definition', async () => {
    const before = await reload();
    expect(before.currentVersion).toBe(1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: editedIps(before.ips, false) },
    });
    expect(res.statusCode).toBe(200);

    const after = await reload();
    // The definition moved...
    expect(after.currentVersion).toBe(2);
    // ...but the runtime stays on what it was serving. This is the assertion
    // that matters: resolving v2 would 404, because no artifact exists there.
    expect(publishedVersionOf(after)).toBe(1);
    expect(hasPendingRegeneration(after)).toBe(true);
  });

  it('does not re-pin on a second edit', async () => {
    // The pin runs on every bump. If it overwrote, the second edit would drag
    // the runtime onto v2 — a version that was never generated.
    for (let i = 0; i < 3; i += 1) {
      const current = await reload();
      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: authHeader(token),
        payload: { ips: editedIps(current.ips, i % 2 === 0) },
      });
    }

    const after = await reload();
    expect(after.currentVersion).toBe(4);
    expect(publishedVersionOf(after)).toBe(1);
  });

  it('leaves the published version alone for a name-only edit', async () => {
    // Renaming does not bump the definition either, so there is nothing to pin.
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { name: 'Renamed' },
    });

    const after = await reload();
    expect(after.currentVersion).toBe(1);
    expect(after.publishedVersion ?? null).toBeNull();
  });

  it('pins on a generationConfig edit too', async () => {
    // `schemaChanged` is set by either `ips` or `generationConfig`, so both bump —
    // and both therefore need the pin.
    const before = await reload();
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { generationConfig: { ...before.generationConfig, mockRecords: 7 } },
    });

    const after = await reload();
    expect(after.currentVersion).toBe(2);
    expect(publishedVersionOf(after)).toBe(1);
  });
});

describe('POST /v1/projects/:id/versions/:version/restore', () => {
  /**
   * The worst of the three. `restore` writes no snapshot and no artifacts — so
   * before the pin, restoring an old version advanced `currentVersion` past every
   * artifact that existed and the hosted URL 404ed immediately. Recovering from a
   * mistake was itself an outage.
   */
  it('does not take the runtime down', async () => {
    const before = await reload();
    await Version.create({
      projectId: before._id,
      version: 1,
      // The model names these `*Snapshot`, not `ips`/`generationConfig`.
      ipsSnapshot: before.ips,
      configSnapshot: before.generationConfig,
      note: 'first',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/versions/1/restore`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);

    const after = await reload();
    expect(after.currentVersion).toBe(2);
    expect(publishedVersionOf(after)).toBe(1);
  });
});

describe('POST /v1/projects/:id/regenerate', () => {
  /**
   * A partial regenerate may legally omit `hosted_api` — `REGENERATABLE_ARTIFACTS`
   * accepts any subset. Before the pin it bumped anyway, so the live URL 404ed
   * permanently until somebody ran a full generate.
   */
  it('pins before bumping, so omitting hosted_api cannot break the runtime', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(token),
      payload: { artifacts: ['openapi'] },
    });
    expect(res.statusCode).toBe(202);

    const after = await reload();
    expect(after.currentVersion).toBe(2);
    expect(publishedVersionOf(after)).toBe(1);
  });
});

describe('what the pin deliberately does NOT do', () => {
  /**
   * Stated plainly, because it is the honest limit of this change.
   *
   * A project already skewed by the old bug — `currentVersion` advanced,
   * artifacts never written — keeps serving nothing until it is regenerated. No
   * backfill can invent artifacts that were never generated; pinning only stops
   * NEW skew.
   */
  it('cannot heal a project that was already skewed', async () => {
    await Project.updateOne({ _id: projectId }, { $set: { currentVersion: 5 } });

    const project = await reload();
    // Nothing pinned it at the time, so the fallback still resolves v5 — which
    // has no artifacts. Only the next successful generation fixes this.
    expect(publishedVersionOf(project)).toBe(5);
    expect(hasPendingRegeneration(project)).toBe(false);
  });

  it('does not advance the published version — only a real publish does', async () => {
    // Every route here is an editing route. The single place `publishedVersion`
    // moves forward is `settleJob` in apps/workers, inside the branch where a
    // `hosted_api` artifact was actually written.
    const before = await reload();
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(token),
      payload: { ips: editedIps(before.ips, false) },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/regenerate`,
      headers: authHeader(token),
      payload: { artifacts: ['openapi'] },
    });

    expect((await reload()).publishedVersion).toBe(1);
  });
});

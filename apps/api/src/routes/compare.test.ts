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
import { Project, Version, type IProject } from '@instantmockapi/db';
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
 * Version comparison (Phase 2 §24, §36, §37).
 *
 * Everything here renders `packages/ips` — `compareSnapshots` and
 * `groupChanges`. There is deliberately no second diff implementation, so what
 * these tests actually check is the *route's* contract: how it resolves each
 * side, what it refuses, what it never sends, and that the counts stay true
 * when the body is capped.
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
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authHeader(token), payload });

const compare = (from: number, to: number) =>
  get(`/v1/projects/${projectId}/versions/compare?from=${from}&to=${to}`);

interface CompareBody {
  from: { version: number; source: string; note: string | null };
  to: { version: number; source: string };
  direction: 'forward' | 'backward';
  summary: {
    total: number;
    changeTypes: Record<string, number>;
    impact: Record<string, number>;
    risk: string | null;
    affectedEntities: number;
    affectedEndpoints: number;
    affectedArtifacts: number;
  };
  matching: {
    byId: number;
    byName: number;
    legacyBothSides: boolean;
    renamesUndetectable: boolean;
    nameMatchedEntities: string[];
  };
  tree: {
    entities: {
      name: string;
      status: string;
      impact: string;
      counts: { total: number };
      endpoints: { method: string; path: string }[];
      own: { change: Record<string, unknown> }[];
      fields: {
        path: string;
        name: string;
        status: string;
        impact: string;
        counts: { total: number };
        changes: { change: Record<string, unknown>; impact: string }[];
      }[];
      relations: { name: string; status: string }[];
      omittedChanges: number;
    }[];
    project: { changes: unknown[]; impact: string | null };
    counts: { total: number; breaking: number };
  };
  truncated: { omittedChanges: number; omittedEntities: number } | null;
  affected: { method: string; path: string }[];
  unaffected: { method: string; path: string }[];
  artifacts: string[];
}

async function body(from: number, to: number): Promise<CompareBody> {
  const response = await compare(from, to);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as CompareBody;
}

/** Edit the live definition through the real route, advancing the version. */
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

const firstEntity = (ips: InternalProjectSchema) => ips.entities[0]!;

/**
 * The fixture's editable leaf.
 *
 * `sampleRaw` is `{ customer: { name, email, age } }`, so the parser produces
 * ONE entity whose fields are `id` and a `customer` object — the interesting
 * scalars are its children. Addressing `fields.find(f => f.name === 'age')`
 * returns undefined, which is how the first draft of this file "edited" nothing
 * and then asserted against a diff that was empty.
 */
function leaf(ips: InternalProjectSchema, name: string) {
  const nested = firstEntity(ips).fields.find((field) => (field.children?.length ?? 0) > 0);
  const found = nested?.children.find((child) => child.name === name);
  if (!found) {
    throw new Error(`fixture has no nested leaf named ${name}`);
  }
  return found;
}

describe('comparing two versions', () => {
  it('reports a field type change, grouped under its entity and field', async () => {
    // v1 is backfilled on read; the edit makes v2.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const result = await body(1, v2);

    expect(result.summary.total).toBeGreaterThan(0);
    // §37: one entity group, one field group beneath it — not a flat list.
    const entity = result.tree.entities[0]!;
    const age = entity.fields.find((field) => field.name === 'age')!;
    expect(age.changes.some((entry) => entry.change['kind'] === 'FIELD_TYPE_CHANGED')).toBe(true);
    expect(age.impact).toBe('BREAKING');
  });

  it('carries the stable ids the client never used to get', async () => {
    // §43, and what lets the UI key rows on elements rather than on names.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      // Inverted, not set to a literal: every leaf the fixture parses out is
      // already `required: true`, so assigning `true` changes nothing and the
      // diff below would be asserting against an unedited definition.
      const field = leaf(ips, 'age');
      field.required = !field.required;
    });

    const result = await body(1, v2);
    const change = result.tree.entities[0]!.fields[0]!.changes[0]!.change;
    expect(change['entityId']).toMatch(/^ent_/);
    expect(change['fieldId']).toMatch(/^fld_/);
  });

  it('carries both projections, computed once on the server', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const change = (await body(1, v2)).tree.entities[0]!.fields[0]!.changes[0]!.change;
    expect(change['changeType']).toBe('MODIFIED');
    expect(change['impact']).toBe('BREAKING');
    // `risk` is still there for anything that wants it — the two axes are just
    // never rendered in the same row.
    expect(change['risk']).toBe('BREAKING');
  });

  it('reports no changes between two snapshots of the same definition', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    // A config-only touch does not change the IPS entities.
    const v2 = await edit(() => {});

    const result = await body(1, v2);
    expect(result.summary.total).toBe(0);
    expect(result.tree.entities).toEqual([]);
  });
});

describe('what does not cross the wire', () => {
  it('never sends a snapshot body', async () => {
    // §28. And §15's side-by-side does not need one: `before`/`after` per field
    // is the panel.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const raw = (await compare(1, v2)).body;
    expect(raw).not.toContain('ipsSnapshot');
    expect(raw).not.toContain('configSnapshot');
  });

  it('does send the before and after values a side-by-side panel needs', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const change = (await body(1, v2)).tree.entities[0]!.fields[0]!.changes[0]!.change;
    expect(change['before']).toBe('integer');
    expect(change['after']).toBe('string');
  });
});

describe('resolving each side', () => {
  it('labels a version that exists only as the live definition', async () => {
    // A schema PATCH before Phase 2 advanced the version and wrote no snapshot.
    // `currentVersion` is the one a user most obviously wants to compare, so it
    // falls back to the live definition — labelled, not disguised.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      firstEntity(ips).description = 'edited';
    });
    await Version.deleteMany({ projectId, version: v2 });

    const result = await body(1, v2);
    expect(result.to.source).toBe('project');
    expect(result.from.source).toBe('version');
  });

  it('refuses a version that was never snapshotted, and says why', async () => {
    // Never silently substitutes a neighbour: a diff of the wrong pair looks
    // exactly like a diff of the right one.
    await get(`/v1/projects/${projectId}/versions`);
    const response = await compare(1, 7);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain('never snapshotted');
    expect(response.json().error.message).toContain('recorded when a project is generated');
  });

  it('backfills the live version so a pre-Phase-2 project is comparable', async () => {
    // §13: never depends on the user having opened the Versions page first.
    await Version.deleteMany({ projectId });
    const v2 = await edit((ips) => {
      firstEntity(ips).description = 'edited';
    });

    const result = await body(1, v2);
    expect(result.from.version).toBe(1);
    expect(await Version.countDocuments({ projectId, version: 1 })).toBe(1);
  });
});

describe('arbitrary pairs, in either direction', () => {
  it('compares non-adjacent versions', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });
    const v3 = await edit((ips) => {
      firstEntity(ips).fields.push({
        name: 'nickname',
        type: 'string',
        required: false,
        default: null,
        children: [],
        validation: {},
        meta: {},
      });
    });

    // v1 → v3, skipping v2 entirely.
    const result = await body(1, v3);
    expect(result.summary.total).toBeGreaterThan(1);
    expect(result.direction).toBe('forward');
  });

  it('marks a backward pair, so a hypothetical is not stated as a fact', async () => {
    // §24 allows `v4 → v2`. It is what a rollback would do, so the impact report
    // is the rollback impact report — but the UI has to say "would" rather than
    // "does".
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const result = await body(v2, 1);
    expect(result.direction).toBe('backward');
    // Reversed: what was a type change one way is the opposite change the other.
    const change = result.tree.entities[0]!.fields[0]!.changes[0]!.change;
    expect(change['before']).toBe('string');
    expect(change['after']).toBe('integer');
  });

  it('rejects a malformed range before touching the database', async () => {
    // Version numbers start at 1, and both sides are required — the schema says
    // so, so these never reach a handler.
    const zero = await get(`/v1/projects/${projectId}/versions/compare?from=0&to=1`);
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.details[0].path).toBe('querystring.from');

    const missing = await get(`/v1/projects/${projectId}/versions/compare?from=1`);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain('validation');
  });
});

describe('the impact report travels with the diff', () => {
  it('names the affected endpoints and artifacts, and spares DELETE', async () => {
    // §16, and the precision rule the graph exists for: `DELETE /x/{id}` sends a
    // path parameter and returns no body, so a field change cannot reach it.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const result = await body(1, v2);
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.affected.some((endpoint) => endpoint.method === 'DELETE')).toBe(false);
    expect(result.unaffected.some((endpoint) => endpoint.method === 'DELETE')).toBe(true);
  });

  it('attaches an entity’s endpoints to its group, for §37’s APIs section', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const entity = (await body(1, v2)).tree.entities[0]!;
    expect(entity.endpoints.length).toBeGreaterThan(0);
    expect(entity.endpoints.some((endpoint) => endpoint.method === 'DELETE')).toBe(false);
  });
});

describe('the summary is computed over everything', () => {
  it('agrees with the tree it heads', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      const entity = firstEntity(ips);
      leaf(ips, 'age').type = 'string';
      const email = leaf(ips, 'email');
      email.required = !email.required;
      entity.description = 'People';
    });

    const result = await body(1, v2);
    expect(result.summary.total).toBe(result.tree.counts.total);

    const bucketed = Object.values(result.summary.impact).reduce((sum, n) => sum + n, 0);
    expect(bucketed).toBe(result.summary.total);
    expect(Object.values(result.summary.changeTypes).reduce((sum, n) => sum + n, 0)).toBe(
      result.summary.total,
    );
  });

  it('reports nothing truncated for an ordinary diff', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    expect((await body(1, v2)).truncated).toBeNull();
  });
});

describe('the matching report', () => {
  it('says nothing was name-matched when both sides carry ids', async () => {
    // Silence is the right answer here: a caveat on a confident comparison
    // trains users to ignore the one that matters.
    await get(`/v1/projects/${projectId}/versions`);
    const v2 = await edit((ips) => {
      leaf(ips, 'age').type = 'string';
    });

    const { matching } = await body(1, v2);
    expect(matching.byName).toBe(0);
    expect(matching.legacyBothSides).toBe(false);
    expect(matching.renamesUndetectable).toBe(false);
  });

  it('flags a comparison of two snapshots that predate stable ids', async () => {
    // The case the whole name fallback exists for. Under ids-only this reports
    // NOTHING, and a page would render that as "no changes detected" — a
    // confident, invisible lie.
    await get(`/v1/projects/${projectId}/versions`);
    const project = await reload();
    const stripped = JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema;
    // Recursively, because the fixture nests: stripping only the top level
    // leaves every child carrying an `fld_`, which is not what a pre-Phase-2
    // snapshot looks like.
    const strip = (fields: { id?: string; children?: unknown[] }[]): void => {
      for (const field of fields) {
        delete field.id;
        if (Array.isArray(field.children)) {
          strip(field.children as { id?: string; children?: unknown[] }[]);
        }
      }
    };
    for (const entity of stripped.entities) {
      delete entity.id;
      strip(entity.fields);
    }
    const changed = JSON.parse(JSON.stringify(stripped)) as InternalProjectSchema;
    leaf(changed, 'age').type = 'string';

    await Version.updateOne({ projectId, version: 1 }, { $set: { ipsSnapshot: stripped } });
    await Version.create({
      projectId: project._id,
      version: 2,
      ipsSnapshot: changed,
      configSnapshot: project.generationConfig,
    });

    const result = await body(1, 2);

    expect(result.matching.legacyBothSides).toBe(true);
    expect(result.matching.renamesUndetectable).toBe(true);
    expect(result.matching.byName).toBeGreaterThan(0);
    // And it still found the real change, which ids-only would have missed.
    expect(result.summary.total).toBeGreaterThan(0);
  });
});

describe('authorization', () => {
  it('does not let another user compare this project’s versions', async () => {
    await get(`/v1/projects/${projectId}/versions`);
    const intruder = (await login(app, 'intruder@example.com')).accessToken;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/versions/compare?from=1&to=1`,
      headers: authHeader(intruder),
    });
    // §40, and NOT_FOUND rather than 403 so existence is not leaked.
    expect(response.statusCode).toBe(404);
  });
});

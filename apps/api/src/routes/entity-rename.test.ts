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
import { Project, type IProject } from '@instantmockapi/db';
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
 * Renaming an entity that something relates to, through the real routes.
 *
 * ## The bug this file exists for
 *
 * `Relation.target` and `FieldMeta.relation` hold entity **names**, not stable
 * ids. So renaming `Product` left `Order.product.target` naming an entity that
 * no longer existed, and `validateIPS` rejected the whole document:
 *
 *     entities[1].relations[0].target
 *     Relation target 'Product' is not a declared entity
 *
 * Which meant **an entity with any inbound relation could not be renamed at
 * all** — a 422 on both write paths, for pressing a button the editor offers.
 *
 * The unit tests in `packages/ips` missed it because they call
 * `materializeRelations` directly and never validate. That is precisely why
 * this file goes through `app.inject`: the failure lived in the *order* the
 * route composes reconcile → validate → materialize, and no test of the pieces
 * could see it.
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

const ipsOf = async (): Promise<InternalProjectSchema> =>
  (await reload()).ips as InternalProjectSchema;

const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authHeader(token), payload });
const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: authHeader(token), ...(payload ? { payload } : {}) });
const get = (url: string) => app.inject({ method: 'GET', url, headers: authHeader(token) });

/**
 * Give the fixture a second entity that relates to the first.
 *
 * The sample project is one entity (`customer`) with no relations, so it cannot
 * exercise this on its own.
 */
async function addRelatedEntity(): Promise<void> {
  const ips = await ipsOf();
  const target = ips.entities[0]!.name;

  const withOrder = {
    ...ips,
    entities: [
      ...ips.entities,
      {
        name: 'Order',
        identity: { field: 'id', style: 'int' as const },
        fields: [
          {
            name: 'total',
            type: 'integer' as const,
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
        ],
        relations: [{ name: 'buyer', kind: 'belongsTo' as const, target }],
      },
    ],
  };

  const response = await patch(`/v1/projects/${projectId}`, { ips: withOrder });
  expect(response.statusCode, response.body).toBe(200);
}

/** The whole stored definition with one entity renamed, as a client would send it. */
async function renamed(from: string, to: string): Promise<Record<string, unknown>> {
  const ips = await ipsOf();
  const clone = JSON.parse(JSON.stringify(ips)) as InternalProjectSchema;
  const entity = clone.entities.find((candidate) => candidate.name === from);
  if (!entity) {
    throw new Error(`no entity named ${from}`);
  }
  entity.name = to;
  return clone as unknown as Record<string, unknown>;
}

describe('PATCH /v1/projects/:id with a renamed entity', () => {
  it('accepts the rename and carries inbound relations to the new name', async () => {
    await addRelatedEntity();
    const before = await ipsOf();
    const oldName = before.entities[0]!.name;

    const response = await patch(`/v1/projects/${projectId}`, {
      ips: await renamed(oldName, 'Client'),
    });
    expect(response.statusCode, response.body).toBe(200);

    const after = await ipsOf();
    const order = after.entities.find((entity) => entity.name === 'Order')!;
    expect(order.relations?.[0]?.target).toBe('Client');
    // The derived foreign key's metadata moves too. Nothing else would ever
    // correct it — `materializeRelations` skips a field that already exists —
    // so it would keep naming a deleted entity, and the include resolver reads it.
    expect(order.fields.find((field) => field.name.endsWith('Id'))?.meta['relation']).toBe(
      'Client',
    );
  });

  it('still rejects a target naming an entity that was never there', async () => {
    // The reconciliation must follow renames, not invent them. A target that
    // matches nothing on either side is a genuine error and stays a 422.
    await addRelatedEntity();
    const ips = await ipsOf();
    const clone = JSON.parse(JSON.stringify(ips)) as InternalProjectSchema;
    clone.entities.find((entity) => entity.name === 'Order')!.relations![0]!.target = 'Ghost';

    const response = await patch(`/v1/projects/${projectId}`, {
      ips: clone as unknown as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details).toEqual([
      {
        path: 'entities[1].relations[0].target',
        issue: "Relation target 'Ghost' is not a declared entity",
      },
    ]);
  });
});

describe('PATCH /v1/projects/:id/draft with a renamed entity', () => {
  it('accepts the rename and reports it as a rename, not a delete plus a create', async () => {
    await addRelatedEntity();
    const before = await ipsOf();
    const oldName = before.entities[0]!.name;

    expect((await post(`/v1/projects/${projectId}/draft`)).statusCode).toBe(201);
    const edit = await patch(`/v1/projects/${projectId}/draft`, {
      ips: await renamed(oldName, 'Client'),
    });
    expect(edit.statusCode, edit.body).toBe(200);

    const analysis = (await get(`/v1/projects/${projectId}/draft/impact`)).json() as {
      risk: string;
      changes: { kind: string; risk: string; aspect: string }[];
    };

    expect(analysis.changes.some((change) => change.kind === 'ENTITY_RENAMED')).toBe(true);
    expect(analysis.changes.some((change) => change.kind.endsWith('_ADDED'))).toBe(false);
    expect(analysis.changes.some((change) => change.kind.endsWith('_REMOVED'))).toBe(false);

    // ROUTING, not BREAKING. The relation echo is real and reported, but at INFO
    // with no aspect — so one rename does not read as a breaking change per
    // inbound relation, which is what would have raised the whole report.
    expect(analysis.risk).toBe('ROUTING');
    const echo = analysis.changes.find((change) => change.kind === 'RELATION_TARGET_CHANGED')!;
    expect(echo.risk).toBe('INFO');
    expect(echo.aspect).toBe('none');
  });

  it('leaves the draft editable and committable after the rename', async () => {
    // A rename that saves but cannot be committed is the same bug one step later.
    await addRelatedEntity();
    const oldName = (await ipsOf()).entities[0]!.name;

    await post(`/v1/projects/${projectId}/draft`);
    await patch(`/v1/projects/${projectId}/draft`, { ips: await renamed(oldName, 'Client') });

    const digest = (
      (await get(`/v1/projects/${projectId}/draft/impact`)).json() as { digest: string }
    ).digest;
    const commit = await post(`/v1/projects/${projectId}/draft/commit`, {
      acknowledgeImpact: digest,
    });

    expect(commit.statusCode, commit.body).toBe(202);
    const after = await ipsOf();
    expect(after.entities.some((entity) => entity.name === 'Client')).toBe(true);
    expect(after.entities.find((entity) => entity.name === 'Order')!.relations?.[0]?.target).toBe(
      'Client',
    );
  });
});

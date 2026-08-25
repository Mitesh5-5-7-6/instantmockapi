import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import {
  ApiLog,
  Artifact,
  MockStore,
  Project,
  User,
  connectDB,
  disconnectDB,
  type IProject,
} from '@instantmockapi/db';
import { artifactKey, createMemoryStorage, type MemoryStorage } from '@instantmockapi/storage';
import { generateHostingConfig } from '@instantmockapi/generator-hosting';
import {
  ALL_QUERY_FEATURES,
  materializeRelations,
  type InternalProjectSchema,
  type QueryFeatures,
} from '@instantmockapi/ips';
import type { HttpMethod } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { createMemoryCache } from './cache.js';
import { buildMockRuntime } from './server.js';

let mongod: MongoMemoryServer;
const storage: MemoryStorage = createMemoryStorage();
const cache = createMemoryCache();

const baseConfig: EnvConfig = loadEnvConfig();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});

beforeEach(async () => {
  storage.clear();
  cache.clear();
  await Promise.all(
    [User, Project, Artifact, MockStore, ApiLog].map((model) => model.deleteMany({})),
  );
});

function makeIps(
  projectId: string,
  methods: HttpMethod[],
  features?: QueryFeatures,
  searchableField?: string,
): InternalProjectSchema {
  return {
    projectId,
    version: 1,
    entities: [
      {
        name: 'Customer',
        fields: [
          {
            name: 'id',
            type: 'uuid',
            required: false,
            default: null,
            children: [],
            validation: {},
            meta: { unique: true },
          },
          {
            name: 'name',
            type: 'string',
            required: true,
            default: '',
            children: [],
            validation: { min: 2, max: 50 },
            meta: searchableField === 'name' ? { searchable: true } : {},
          },
          {
            name: 'email',
            type: 'email',
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
          {
            name: 'status',
            type: 'enum',
            required: false,
            default: 'active',
            children: [],
            validation: { enum: ['active', 'inactive'] },
            meta: {},
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod'],
      types: [],
      methods,
      mockRecords: 3,
      // Left off entirely when not asked for, so the default staging path keeps
      // exercising a config that predates the query layer.
      ...(features ? { features } : {}),
    },
  };
}

/** Stage a hosted project exactly as the worker pipeline leaves it. */
async function stageHostedProject(options: {
  methods?: HttpMethod[];
  status?: IProject['status'];
  expiresAt?: Date;
  records?: Record<string, unknown>[];
  /** Set to make the project addressable by its pretty URL too. */
  publicId?: string;
  slug?: string;
  /** Query toggles; omitted entirely to stage a pre-query-layer config. */
  features?: QueryFeatures;
  /** Field to mark `meta.searchable`, narrowing the search whitelist. */
  searchableField?: string;
}): Promise<string> {
  const {
    methods = ['GET', 'POST', 'PUT', 'PATCH'],
    status = 'active',
    expiresAt = new Date(Date.now() + 86_400_000),
    records = [
      { id: 'c-1', name: 'Ada Lovelace', email: 'ada@example.com', status: 'active' },
      { id: 'c-2', name: 'Grace Hopper', email: 'grace@example.com', status: 'active' },
      { id: 'c-3', name: 'Edsger Dijkstra', email: 'edsger@example.com', status: 'inactive' },
    ],
  } = options;

  const user = await User.create({
    email: `owner-${Math.random().toString(36).slice(2)}@x.dev`,
    authProvider: 'email',
  });
  const project = new Project({
    ownerId: user._id,
    name: 'Hosted Test',
    status,
    ...(options.publicId ? { publicId: options.publicId } : {}),
    ...(options.slug ? { slug: options.slug } : {}),
    inputSource: { type: 'json', raw: '{}' },
    currentVersion: 1,
    hosted: { url: 'https://api.instantmockapi.dev/p/x', expiresAt },
  });
  const ips = makeIps(String(project._id), methods, options.features, options.searchableField);
  project.ips = ips;
  project.generationConfig = ips.generationConfig;
  await project.save();
  const projectId = String(project._id);

  const configFiles = generateHostingConfig(ips);
  const ref = artifactKey(projectId, 1, 'hosted_api', 'hosting.config.json');
  await storage.put(ref, configFiles['hosting.config.json'] ?? '{}', 'application/json');
  await Artifact.create({
    projectId: project._id,
    artifactType: 'hosted_api',
    version: 1,
    status: 'completed',
    storageRef: ref,
    generatedAt: new Date(),
    workerId: 'F',
  });

  await MockStore.create({ projectId: project._id, entity: 'customer', records });
  return projectId;
}

/**
 * Wait for at least `count` apiLogs rows for a project.
 *
 * The logging hook deliberately does not await its insert — logging must never
 * delay a hosted response — so a test that reads straight after `inject`
 * resolves is racing the write. Polling is the assertion the contract actually
 * supports: the entry lands shortly, not synchronously.
 */
async function waitForLogs(projectId: string, count = 1): Promise<number> {
  let logs = 0;
  for (let attempt = 0; attempt < 40 && logs < count; attempt++) {
    logs = await ApiLog.countDocuments({ projectId });
    if (logs < count) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return logs;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildMockRuntime({ config: baseConfig, storage, cache, rateLimit: false });
});

afterAll(async () => {
  await app.close();
});

describe('CRUD on generated endpoints (doc 08 §9)', () => {
  it('GET lists seeded records with the pagination envelope', async () => {
    const projectId = await stageHostedProject({});
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({ id: 'c-1', name: 'Ada Lovelace' });
  });

  it('paginates and caps the limit at the configured max', async () => {
    const projectId = await stageHostedProject({});
    const page2 = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?page=2&limit=2`,
    });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().meta).toEqual({ page: 2, limit: 2, total: 3 });

    const capped = await app.inject({ method: 'GET', url: `/p/${projectId}/customer?limit=5000` });
    expect(capped.json().meta.limit).toBe(baseConfig.maxPaginationLimit);
  });

  it('GET by id returns the record; unknown id → 404', async () => {
    const projectId = await stageHostedProject({});
    const hit = await app.inject({ method: 'GET', url: `/p/${projectId}/customer/c-2` });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().name).toBe('Grace Hopper');

    const miss = await app.inject({ method: 'GET', url: `/p/${projectId}/customer/nope` });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('NOT_FOUND');
  });

  it('POST validates, assigns an id, persists, and is immediately readable', async () => {
    const projectId = await stageHostedProject({});
    const res = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer`,
      payload: { name: 'Alan Turing', email: 'alan@example.com' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.id).toEqual(expect.any(String));

    // write-through: cached list was invalidated
    const list = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(list.json().meta.total).toBe(4);

    const fetched = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer/${created.id}`,
    });
    expect(fetched.statusCode).toBe(200);
  });

  it('POST with a duplicate id → 409 (validation runs first, so the id must be valid)', async () => {
    const projectId = await stageHostedProject({});
    const uuid = '3f6c1d2e-8a4b-4c5d-9e0f-1a2b3c4d5e6f';
    const first = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer`,
      payload: { id: uuid, name: 'Original', email: 'orig@example.com' },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer`,
      payload: { id: uuid, name: 'Copy Cat', email: 'copy@example.com' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
  });

  it('invalid writes → 422 with field-level errors from the generated rules', async () => {
    const projectId = await stageHostedProject({});
    const res = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer`,
      payload: { name: 'A', email: 'not-an-email', status: 'archived' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const paths = body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toContain('name');
    expect(paths).toContain('email');
    expect(paths).toContain('status');
  });

  it('PUT replaces with full validation; PATCH merges and validates partially', async () => {
    const projectId = await stageHostedProject({});

    const put = await app.inject({
      method: 'PUT',
      url: `/p/${projectId}/customer/c-1`,
      payload: { name: 'Ada King', email: 'ada@lovelace.dev', status: 'inactive' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: 'c-1', name: 'Ada King', status: 'inactive' });

    const badPut = await app.inject({
      method: 'PUT',
      url: `/p/${projectId}/customer/c-1`,
      payload: { name: 'Ada King' }, // email missing → full validation fails
    });
    expect(badPut.statusCode).toBe(422);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/p/${projectId}/customer/c-2`,
      payload: { status: 'inactive' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ id: 'c-2', name: 'Grace Hopper', status: 'inactive' });

    const badPatch = await app.inject({
      method: 'PATCH',
      url: `/p/${projectId}/customer/c-2`,
      payload: { email: 'broken' },
    });
    expect(badPatch.statusCode).toBe(422);
  });
});

describe('method gating (doc 08 §9: unselected → 405)', () => {
  it('DELETE is 405 when not selected; selected methods still work', async () => {
    const projectId = await stageHostedProject({ methods: ['GET', 'POST', 'PUT', 'PATCH'] });
    const res = await app.inject({ method: 'DELETE', url: `/p/${projectId}/customer/c-1` });
    expect(res.statusCode).toBe(405);

    const list = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(list.statusCode).toBe(200);
  });

  it('DELETE works when selected', async () => {
    const projectId = await stageHostedProject({ methods: ['GET', 'DELETE'] });
    const del = await app.inject({ method: 'DELETE', url: `/p/${projectId}/customer/c-1` });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(list.json().meta.total).toBe(2);

    // GET-only sibling verbs on this project: POST unselected → 405
    const post = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer`,
      payload: { name: 'X Y', email: 'x@y.dev' },
    });
    expect(post.statusCode).toBe(405);
  });

  it('writes to collection/record URLs with the wrong shape → 405 guidance', async () => {
    const projectId = await stageHostedProject({});
    const putCollection = await app.inject({
      method: 'PUT',
      url: `/p/${projectId}/customer`,
      payload: {},
    });
    expect(putCollection.statusCode).toBe(405);

    const postRecord = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/customer/c-1`,
      payload: {},
    });
    expect(postRecord.statusCode).toBe(405);
  });
});

describe('tenant isolation (doc 13 §4)', () => {
  it('projects with the same entity name never see each other’s data', async () => {
    const projectA = await stageHostedProject({
      records: [{ id: 'a-1', name: 'Alpha One', email: 'a1@a.dev' }],
    });
    const projectB = await stageHostedProject({
      records: [{ id: 'b-1', name: 'Beta One', email: 'b1@b.dev' }],
    });

    const listA = await app.inject({ method: 'GET', url: `/p/${projectA}/customer` });
    expect(listA.json().data).toHaveLength(1);
    expect(listA.json().data[0].id).toBe('a-1');

    // B's record is unreachable through A's URL space
    const cross = await app.inject({ method: 'GET', url: `/p/${projectA}/customer/b-1` });
    expect(cross.statusCode).toBe(404);

    // Writes stay namespaced
    await app.inject({
      method: 'POST',
      url: `/p/${projectA}/customer`,
      payload: { name: 'Alpha Two', email: 'a2@a.dev' },
    });
    const listB = await app.inject({ method: 'GET', url: `/p/${projectB}/customer` });
    expect(listB.json().meta.total).toBe(1);
  });
});

describe('lifecycle 404s (doc 07 §6)', () => {
  it('expired-by-date, expired-status, and draft projects do not resolve', async () => {
    const pastDate = await stageHostedProject({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await stageHostedProject({ status: 'expired' });
    const draft = await stageHostedProject({ status: 'draft' });

    for (const projectId of [pastDate, expired, draft]) {
      const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('unknown entities and malformed project ids → 404', async () => {
    const projectId = await stageHostedProject({});
    expect((await app.inject({ method: 'GET', url: `/p/${projectId}/orders` })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/p/definitely-not-an-id/customer' })).statusCode,
    ).toBe(404);
  });
});

describe('abuse bounds (doc 13 §4–5)', () => {
  it('rejects writes once the per-entity record cap is reached', async () => {
    const projectId = await stageHostedProject({});
    const capped = await buildMockRuntime({
      config: { ...baseConfig, maxMockRecords: 3 },
      storage,
      cache,
      rateLimit: false,
    });
    try {
      const res = await capped.inject({
        method: 'POST',
        url: `/p/${projectId}/customer`,
        payload: { name: 'One Too Many', email: 'otm@example.com' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/full/i);
    } finally {
      await capped.close();
    }
  });

  it('caps request body size (413)', async () => {
    const projectId = await stageHostedProject({});
    const tiny = await buildMockRuntime({
      config: { ...baseConfig, maxRequestBodySize: 128 },
      storage,
      cache,
      rateLimit: false,
    });
    try {
      const res = await tiny.inject({
        method: 'POST',
        url: `/p/${projectId}/customer`,
        payload: { name: 'Big', email: 'big@example.com', blob: 'x'.repeat(4096) },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    } finally {
      await tiny.close();
    }
  });

  it('rate limits per project — one noisy project cannot exhaust another', async () => {
    const projectA = await stageHostedProject({});
    const projectB = await stageHostedProject({});
    const limited = await buildMockRuntime({
      config: baseConfig,
      storage,
      cache,
      rateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    try {
      await limited.inject({ method: 'GET', url: `/p/${projectA}/customer` });
      await limited.inject({ method: 'GET', url: `/p/${projectA}/customer` });
      const third = await limited.inject({ method: 'GET', url: `/p/${projectA}/customer` });
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMIT_EXCEEDED');

      const other = await limited.inject({ method: 'GET', url: `/p/${projectB}/customer` });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('request logging (doc 13 §9)', () => {
  it('writes apiLogs entries for hosted requests', async () => {
    const projectId = await stageHostedProject({});
    await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    await app.inject({ method: 'GET', url: `/p/${projectId}/customer/nope` });

    expect(await waitForLogs(projectId, 2)).toBeGreaterThanOrEqual(2);
    const entry = await ApiLog.findOne({ projectId, status: 404 });
    expect(entry?.method).toBe('GET');
    expect(entry?.path).toContain('/customer/nope');
  });

  it('records how long the request took', async () => {
    const projectId = await stageHostedProject({});
    await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });

    expect(await waitForLogs(projectId)).toBeGreaterThanOrEqual(1);
    const entry = await ApiLog.findOne({ projectId });
    // A whole, non-negative number of milliseconds. Deliberately no upper bound:
    // a loaded CI box blows any threshold, and this is asserting that the value
    // is captured at all — not that the runtime is fast.
    expect(typeof entry?.durationMs).toBe('number');
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(entry?.durationMs)).toBe(true);
  });
});

describe('pretty slug URLs are additive (doc 19 §Phase 3)', () => {
  const PID = 'prj_7d5e9a2f1c';
  const SLUG = 'student-erp';

  async function staged(): Promise<string> {
    return stageHostedProject({ publicId: PID, slug: SLUG });
  }

  it('serves a collection through the pretty URL', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${PID}/${SLUG}/customer` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(3);
  });

  it('serves a record through the pretty URL', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${PID}/${SLUG}/customer/c-2` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'c-2', name: 'Grace Hopper' });
  });

  it('accepts writes through the pretty URL', async () => {
    await staged();
    const res = await app.inject({
      method: 'POST',
      url: `/p/${PID}/${SLUG}/customer`,
      payload: { name: 'Alan Turing', email: 'alan@example.com', status: 'active' },
    });
    expect(res.statusCode).toBe(201);
  });

  // The additive guarantee: an already-copied URL keeps working after the project
  // gains a public id.
  it('still serves the legacy ObjectId URL for the same project', async () => {
    const projectId = await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(3);
  });

  it('resolves on publicId alone, so a stale slug still works', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${PID}/renamed-yesterday/customer` });
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown public id', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/prj_deadbeef00/x/customer` });
    expect(res.statusCode).toBe(404);
  });

  it('404s a bare public id — the slug segment is part of the base URL', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${PID}` });
    expect(res.statusCode).toBe(404);
  });

  it('404s beyond the record segment', async () => {
    await staged();
    const res = await app.inject({ method: 'GET', url: `/p/${PID}/${SLUG}/customer/c-1/marks` });
    expect(res.statusCode).toBe(404);
  });

  /**
   * Both forms normalise to the canonical ObjectId before any cache key is built,
   * so they share every cache entry. If a form discriminator ever leaks into a
   * key, the second request here misses and this fails.
   */
  it('shares cached config and seed between the two URL forms', async () => {
    const projectId = await staged();
    await app.inject({ method: 'GET', url: `/p/${PID}/${SLUG}/customer` });
    const warm = cache.stats().misses;
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer` });
    expect(res.statusCode).toBe(200);
    expect(cache.stats().misses).toBe(warm);
  });

  it('logs the canonical ObjectId for a pretty-URL request', async () => {
    const projectId = await staged();
    await app.inject({ method: 'GET', url: `/p/${PID}/${SLUG}/customer` });
    // The hook reads a request decorator, not a route param — a pretty URL must
    // never log `prj_…`, because ApiLog.projectId is an ObjectId ref.
    expect(await waitForLogs(projectId)).toBeGreaterThanOrEqual(1);
    const entry = await ApiLog.findOne({ projectId });
    expect(entry).not.toBeNull();
    expect(entry?.path).toContain(`/p/${PID}/${SLUG}/customer`);
  });

  it('words the wrong-shape 405 with the caller’s own URL form', async () => {
    await staged();
    const res = await app.inject({ method: 'PATCH', url: `/p/${PID}/${SLUG}/customer` });
    expect(res.statusCode).toBe(405);
    expect(res.json().error.message).toContain(`/p/${PID}/${SLUG}/{entity}/{recordId}`);
  });

  it('advertises an Allow header when the method is not enabled', async () => {
    await staged();
    const res = await app.inject({ method: 'DELETE', url: `/p/${PID}/${SLUG}/customer/c-1` });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET, POST, PUT, PATCH');
  });
});

describe('discovery document at the base URL', () => {
  it('lists entities and their methods for the pretty URL', async () => {
    await stageHostedProject({ publicId: 'prj_aaaaaaaaaa', slug: 'demo' });
    const res = await app.inject({ method: 'GET', url: '/p/prj_aaaaaaaaaa/demo' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.kind).toBe('project');
    expect(data.version).toBe(1);
    expect(data.canonicalUrl).toBe('https://api.instantmockapi.dev/p/prj_aaaaaaaaaa/demo');
    expect(data.entities).toEqual([
      {
        name: 'Customer',
        path: 'customer',
        methods: ['GET', 'POST', 'PUT', 'PATCH'],
        url: 'https://api.instantmockapi.dev/p/prj_aaaaaaaaaa/demo/customer',
      },
    ]);
  });

  it('serves the legacy base URL too, falling back to the id form', async () => {
    const projectId = await stageHostedProject({});
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.canonicalUrl).toBe(`https://api.instantmockapi.dev/p/${projectId}`);
  });
});

describe('rate limiting keys on the project, not the URL form', () => {
  it('counts both URL forms against one bucket', async () => {
    const PID = 'prj_bbbbbbbbbb';
    const projectId = await stageHostedProject({ publicId: PID, slug: 'demo' });
    const limited = await buildMockRuntime({
      config: baseConfig,
      storage,
      cache,
      rateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    try {
      // Warm the publicId→ObjectId index so the pretty key canonicalises.
      const first = await limited.inject({ method: 'GET', url: `/p/${projectId}/customer` });
      expect(first.statusCode).toBe(200);
      const second = await limited.inject({ method: 'GET', url: `/p/${PID}/demo/customer` });
      expect(second.statusCode).toBe(200);
      // Third request across either form must exceed the shared allowance.
      const third = await limited.inject({ method: 'GET', url: `/p/${PID}/demo/customer` });
      expect(third.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

/**
 * A two-entity relational project, staged the way the worker pipeline leaves it.
 *
 * Relations are materialized first, exactly as the API does on every input, so
 * the foreign-key field the join reads is really present in the schema.
 */
async function stageRelationalProject(features: QueryFeatures): Promise<string> {
  const text = (name: string): InternalProjectSchema['entities'][number]['fields'][number] => ({
    name,
    type: 'string',
    required: true,
    default: null,
    children: [],
    validation: {},
    meta: {},
  });

  const user = await User.create({
    email: `owner-${Math.random().toString(36).slice(2)}@x.dev`,
    authProvider: 'email',
  });
  const project = new Project({
    ownerId: user._id,
    name: 'Relational Test',
    status: 'active',
    inputSource: { type: 'json', raw: '{}' },
    currentVersion: 1,
    hosted: {
      url: 'https://api.instantmockapi.dev/p/x',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const projectId = String(project._id);

  const ips = materializeRelations({
    projectId,
    version: 1,
    entities: [
      {
        name: 'Classroom',
        identity: { field: 'id', style: 'int' },
        fields: [text('name')],
        relations: [
          {
            name: 'students',
            kind: 'hasMany',
            target: 'Student',
            localField: '',
            foreignField: '',
            required: false,
            onDelete: 'restrict',
          },
        ],
      },
      {
        name: 'Student',
        identity: { field: 'id', style: 'int' },
        fields: [text('name')],
        relations: [
          {
            name: 'classroom',
            kind: 'belongsTo',
            target: 'Classroom',
            localField: '',
            foreignField: '',
            required: true,
            onDelete: 'restrict',
          },
        ],
      },
    ],
    generationConfig: {
      validators: [],
      types: [],
      methods: ['GET'],
      mockRecords: 3,
      features,
    },
  });

  project.ips = ips;
  project.generationConfig = ips.generationConfig;
  await project.save();

  const configFiles = generateHostingConfig(ips);
  const ref = artifactKey(projectId, 1, 'hosted_api', 'hosting.config.json');
  await storage.put(ref, configFiles['hosting.config.json'] ?? '{}', 'application/json');
  await Artifact.create({
    projectId: project._id,
    artifactType: 'hosted_api',
    version: 1,
    status: 'completed',
    storageRef: ref,
    generatedAt: new Date(),
    workerId: 'F',
  });

  await MockStore.create({
    projectId: project._id,
    entity: 'classroom',
    records: [
      { id: 1, name: 'Room A' },
      { id: 2, name: 'Room B' },
    ],
  });
  await MockStore.create({
    projectId: project._id,
    entity: 'student',
    records: [
      { id: 1, name: 'Ada', classroomId: 1 },
      { id: 2, name: 'Grace', classroomId: 2 },
      { id: 3, name: 'Alan', classroomId: 1 },
    ],
  });

  return projectId;
}

describe('query layer — filtering (doc 19 §Phase 4)', () => {
  it('filters on a bare field name and counts only what matched', () =>
    (async () => {
      const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
      const res = await app.inject({
        method: 'GET',
        url: `/p/${projectId}/customer?status=active`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.map((r: { name: string }) => r.name)).toEqual([
        'Ada Lovelace',
        'Grace Hopper',
      ]);
      // total is the filtered count — otherwise a paginating client would ask
      // for pages that cannot exist.
      expect(body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    })());

  it('applies operator suffixes', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const notActive = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?status_ne=active`,
    });
    expect(notActive.json().data.map((r: { name: string }) => r.name)).toEqual(['Edsger Dijkstra']);

    const like = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?name_like=GRACE`,
    });
    expect(like.json().data).toHaveLength(1);

    const oneOf = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?id_in=c-1,c-3`,
    });
    expect(oneOf.json().meta.total).toBe(2);
  });

  it('rejects a mistyped filter with a 400 that lists the real fields', async () => {
    // The alternative — silently returning the unfiltered collection — reads as
    // "filtering is broken" and gives the caller nothing to go on.
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?stauts=active`,
    });
    expect(res.statusCode).toBe(400);
    const error = res.json().error;
    expect(error.message).toContain("'stauts'");
    expect(error.details[0].issue).toContain('status');
  });

  it('combines a filter with pagination over the filtered set', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?status=active&page=2&limit=1`,
    });
    expect(res.json().data.map((r: { name: string }) => r.name)).toEqual(['Grace Hopper']);
    expect(res.json().meta).toEqual({ page: 2, limit: 1, total: 2 });
  });
});

describe('query layer — search', () => {
  it('matches a term across every textual field by default', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const byName = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?search=hopper`,
    });
    expect(byName.json().data.map((r: { name: string }) => r.name)).toEqual(['Grace Hopper']);

    // status is an enum, and enums are textual — so the term reaches it too.
    const byStatus = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?search=inactive`,
    });
    expect(byStatus.json().meta.total).toBe(1);
  });

  it('narrows to the whitelist once a field is marked searchable', async () => {
    const projectId = await stageHostedProject({
      features: ALL_QUERY_FEATURES,
      searchableField: 'name',
    });
    const byName = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?search=hopper`,
    });
    expect(byName.json().meta.total).toBe(1);

    // status is no longer searched, because name claimed the whitelist.
    const byStatus = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?search=inactive`,
    });
    expect(byStatus.json().meta.total).toBe(0);
  });

  it('treats an empty term as no search at all', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer?search=` });
    expect(res.json().meta.total).toBe(3);
  });
});

describe('query layer — sorting', () => {
  it('sorts ascending and descending', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const up = await app.inject({ method: 'GET', url: `/p/${projectId}/customer?sort=name` });
    expect(up.json().data.map((r: { name: string }) => r.name)).toEqual([
      'Ada Lovelace',
      'Edsger Dijkstra',
      'Grace Hopper',
    ]);

    const down = await app.inject({ method: 'GET', url: `/p/${projectId}/customer?sort=-name` });
    expect(down.json().data.map((r: { name: string }) => r.name)).toEqual([
      'Grace Hopper',
      'Edsger Dijkstra',
      'Ada Lovelace',
    ]);
  });

  it('paginates a sorted collection without repeating or dropping a record', async () => {
    // The property that matters: page 1 + page 2 must reconstruct the whole
    // ordered collection exactly once each.
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const url = (page: number) => `/p/${projectId}/customer?sort=status&page=${page}&limit=2`;
    const first = await app.inject({ method: 'GET', url: url(1) });
    const second = await app.inject({ method: 'GET', url: url(2) });
    const ids = [...first.json().data, ...second.json().data].map((r: { id: string }) => r.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects an unsortable field', async () => {
    const projectId = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}/customer?sort=nope` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Sortable fields');
  });
});

describe('query layer — include', () => {
  it('expands an owning relation on a collection', async () => {
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student?include=classroom`,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { name: string; classroom: { name: string } }[];
    expect(rows.map((r) => r.classroom.name)).toEqual(['Room A', 'Room B', 'Room A']);
  });

  it('expands an inverse relation to an array', async () => {
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/classroom?include=students`,
    });
    const rows = res.json().data as { name: string; students: { name: string }[] }[];
    expect(rows[0]?.students.map((s) => s.name)).toEqual(['Ada', 'Alan']);
    expect(rows[1]?.students.map((s) => s.name)).toEqual(['Grace']);
  });

  it('expands on a single record too', async () => {
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student/2?include=classroom`,
    });
    expect(res.statusCode).toBe(200);
    // id comes back as a number: the entity uses int identity, so the record
    // carries 2 and its own value wins over the string from the URL.
    expect(res.json()).toMatchObject({ id: 2, name: 'Grace', classroom: { name: 'Room B' } });
  });

  it('combines with a filter on the foreign key that relations created', async () => {
    // ?classroomId=1 only works because materialization put that field in the
    // schema, which is what makes it filterable.
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student?classroomId=1&include=classroom&sort=-name`,
    });
    const rows = res.json().data as { name: string; classroom: { name: string } }[];
    expect(rows.map((r) => r.name)).toEqual(['Alan', 'Ada']);
    expect(rows.every((r) => r.classroom.name === 'Room A')).toBe(true);
    expect(res.json().meta.total).toBe(2);
  });

  it('rejects an unknown relation and lists the real ones', async () => {
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student?include=teacher`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('classroom');
  });

  it('rejects a nested include with advice rather than a generic error', async () => {
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student?include=classroom.students`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Nested includes are not supported');
  });

  it('resolves a join against seeds that carry no identity value', async () => {
    // Records written before identity fields existed route on the positional
    // rec-N fallback. The join has to read that same resolved value, or the
    // expansion silently comes back null.
    const projectId = await stageRelationalProject(ALL_QUERY_FEATURES);
    await MockStore.findOneAndUpdate(
      { projectId, entity: 'classroom' },
      { $set: { records: [{ name: 'Legacy Room' }] } },
    );
    await MockStore.findOneAndUpdate(
      { projectId, entity: 'student' },
      { $set: { records: [{ name: 'Ada', classroomId: 'rec-1' }] } },
    );
    cache.clear();

    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/student?include=classroom`,
    });
    expect(res.json().data[0].classroom).toMatchObject({ id: 'rec-1', name: 'Legacy Room' });
  });
});

describe('query layer — disabled features and legacy configs', () => {
  it('tells the caller which toggle to turn on', async () => {
    const projectId = await stageHostedProject({});
    for (const [parameter, toggle] of [
      ['search=x', 'search'],
      ['sort=name', 'sorting'],
      ['include=orders', 'relations'],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/p/${projectId}/customer?${parameter}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain(toggle);
    }
  });

  it('ignores a field filter entirely when filtering is off', async () => {
    // A config written before the query layer must answer exactly as it did:
    // the parameter is neither honoured nor rejected.
    const projectId = await stageHostedProject({});
    const res = await app.inject({
      method: 'GET',
      url: `/p/${projectId}/customer?status=active&utm_source=email`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toEqual({ page: 1, limit: 20, total: 3 });
  });

  it('serves an unchanged discovery document for a pre-query-layer project', async () => {
    const projectId = await stageHostedProject({});
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}` });
    expect(res.json().data.features).toEqual([]);
    // No query key at all, rather than four empty lists.
    expect(res.json().data.entities[0]).not.toHaveProperty('query');
  });

  it('advertises only the enabled capabilities in the discovery document', async () => {
    const projectId = await stageHostedProject({
      features: { search: true, filter: false, sort: true, include: false },
    });
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}` });
    const data = res.json().data;
    expect(data.features).toEqual(['search', 'sort']);
    const entity = data.entities[0];
    expect(Object.keys(entity.query).sort()).toEqual(['searchable', 'sortable']);
    expect(entity.query.sortable).toContain('status');
  });

  it('returns identical output with every feature on and no parameters sent', async () => {
    // The additivity guarantee: enabling the query layer on a live project
    // cannot change any response a client is already making.
    const off = await stageHostedProject({});
    const on = await stageHostedProject({ features: ALL_QUERY_FEATURES });
    const offBody = (await app.inject({ method: 'GET', url: `/p/${off}/customer` })).json();
    const onBody = (await app.inject({ method: 'GET', url: `/p/${on}/customer` })).json();
    expect(onBody).toEqual(offBody);
  });
});

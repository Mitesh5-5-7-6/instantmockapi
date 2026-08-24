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
import type { InternalProjectSchema } from '@instantmockapi/ips';
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

function makeIps(projectId: string, methods: HttpMethod[]): InternalProjectSchema {
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
            meta: {},
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
    generationConfig: { validators: ['zod'], types: [], methods, mockRecords: 3 },
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
  const ips = makeIps(String(project._id), methods);
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

    // fire-and-forget writes — poll briefly
    let logs = 0;
    for (let attempt = 0; attempt < 20 && logs < 2; attempt++) {
      logs = await ApiLog.countDocuments({ projectId });
      if (logs < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(logs).toBeGreaterThanOrEqual(2);
    const entry = await ApiLog.findOne({ projectId, status: 404 });
    expect(entry?.method).toBe('GET');
    expect(entry?.path).toContain('/customer/nope');
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

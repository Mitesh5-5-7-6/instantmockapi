import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { connectDB, disconnectDB } from './connection.js';
import { User } from './models/user.js';
import { Project, type IProject } from './models/project.js';
import { Version } from './models/version.js';
import { Artifact } from './models/artifact.js';
import { Job } from './models/job.js';
import { MockStore } from './models/mockStore.js';
import { ApiLog } from './models/apiLog.js';
import {
  findExpiredProjects,
  expireProjectInDB,
  hardDeleteProject,
  ensurePublicIdentity,
} from './queries.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
});

const generationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST'],
  mockRecords: 25,
};

function makeProject(overrides: Partial<Record<string, unknown>> = {}): Promise<IProject> {
  const ownerId = new Types.ObjectId();
  return Project.create({
    ownerId,
    name: 'Test Project',
    inputSource: { type: 'json', raw: '{"customer":{"email":"a@b.com"}}' },
    ips: {
      projectId: 'p1',
      version: 1,
      entities: [],
      generationConfig,
    },
    generationConfig,
    ...overrides,
  });
}

describe('models', () => {
  it('applies user defaults and lowercases email', async () => {
    const user = await User.create({ email: 'Dev@Example.COM', authProvider: 'email' });
    expect(user.email).toBe('dev@example.com');
    expect(user.plan).toBe('free');
  });

  it('enforces unique user emails', async () => {
    await User.syncIndexes();
    await User.create({ email: 'dup@example.com', authProvider: 'email' });
    await expect(User.create({ email: 'dup@example.com', authProvider: 'google' })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('applies project defaults (draft, version 1, unhosted)', async () => {
    const project = await makeProject();
    expect(project.status).toBe('draft');
    expect(project.currentVersion).toBe(1);
    expect(project.hosted.url).toBeNull();
    expect(project.hosted.expiresAt).toBeNull();
  });

  it('enforces the unique (projectId, artifactType, version) registry key', async () => {
    await Artifact.syncIndexes();
    const projectId = new Types.ObjectId();
    await Artifact.create({ projectId, artifactType: 'zod', version: 1 });
    await expect(Artifact.create({ projectId, artifactType: 'zod', version: 1 })).rejects.toThrow(
      /duplicate key/i,
    );
    // Same artifact at another version is a separate registry row
    await expect(
      Artifact.create({ projectId, artifactType: 'zod', version: 2 }),
    ).resolves.toBeDefined();
  });

  it('enforces unique job idempotency keys', async () => {
    await Job.syncIndexes();
    const base = {
      projectId: new Types.ObjectId(),
      version: 1,
      type: 'full',
      requestedArtifacts: ['zod'],
      idempotencyKey: 'abc123',
    };
    await Job.create(base);
    await expect(Job.create({ ...base, projectId: new Types.ObjectId() })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('declares a 30-day TTL index on apiLogs.at', async () => {
    await ApiLog.syncIndexes();
    const indexes = await ApiLog.collection.indexes();
    const ttl = indexes.find((idx) => idx.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl?.key).toEqual({ at: 1 });
    expect(ttl?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('declares a compound {projectId, at} index alongside the TTL index', async () => {
    // Both must exist. A TTL index cannot be compound, so the compound index
    // cannot absorb it — and "consolidating" them would silently disable
    // retention while leaving every read fast. That is the failure this pins.
    await ApiLog.syncIndexes();
    const indexes = await ApiLog.collection.indexes();

    const compound = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ projectId: 1, at: -1 }),
    );
    expect(compound).toBeDefined();
    // The read index must not carry a TTL, or it would expire rows on its own.
    expect(compound?.expireAfterSeconds).toBeUndefined();

    // Field order is load-bearing: equality before range, or the window scan
    // cannot be bounded per project.
    expect(Object.keys(compound?.key ?? {})).toEqual(['projectId', 'at']);
    expect(indexes.filter((idx) => idx.expireAfterSeconds !== undefined)).toHaveLength(1);
  });

  it('stores an optional durationMs on apiLogs', async () => {
    // Rows written before the field existed carry null and cannot be backfilled,
    // so a missing value has to be representable rather than defaulted to 0.
    const projectId = new Types.ObjectId();
    const base = { projectId, method: 'GET', path: '/p/x/customer', status: 200, at: new Date() };

    const timed = await ApiLog.create({ ...base, durationMs: 12 });
    expect(timed.durationMs).toBe(12);

    const untimed = await ApiLog.create(base);
    expect(untimed.durationMs).toBeNull();
  });
});

describe('findExpiredProjects', () => {
  it('returns only active projects whose hosted.expiresAt has passed', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const expiredActive = await makeProject({
      status: 'active',
      hosted: { url: 'https://x/p/1', expiresAt: past },
    });
    await makeProject({ status: 'active', hosted: { url: 'https://x/p/2', expiresAt: future } });
    await makeProject({ status: 'draft', hosted: { url: null, expiresAt: past } });
    await makeProject({ status: 'expired', hosted: { url: null, expiresAt: past } });

    const found = await findExpiredProjects();
    expect(found).toHaveLength(1);
    expect(String(found[0]?._id)).toBe(String(expiredActive._id));
  });
});

describe('expireProjectInDB', () => {
  it('deletes ephemeral data, nulls artifact refs, and marks the project expired', async () => {
    const project = await makeProject({
      status: 'active',
      hosted: { url: 'https://x/p/1', expiresAt: new Date() },
    });
    const projectId = String(project._id);

    await MockStore.create({ projectId: project._id, entity: 'customer', records: [{ id: 1 }] });
    await ApiLog.create({
      projectId: project._id,
      method: 'GET',
      path: '/customers',
      status: 200,
      at: new Date(),
    });
    await Artifact.create({
      projectId: project._id,
      artifactType: 'zod',
      version: 1,
      status: 'completed',
      storageRef: 's3://bucket/zod.ts',
    });

    await expireProjectInDB(projectId);

    expect(await MockStore.countDocuments({ projectId: project._id })).toBe(0);
    expect(await ApiLog.countDocuments({ projectId: project._id })).toBe(0);

    const artifact = await Artifact.findOne({ projectId: project._id });
    expect(artifact?.storageRef).toBeNull();

    const updated = await Project.findById(project._id);
    expect(updated?.status).toBe('expired');
    expect(updated?.hosted.url).toBeNull();
    expect(updated?.hosted.expiresAt).toBeNull();
  });
});

describe('hardDeleteProject', () => {
  it('removes the project and every related document', async () => {
    const project = await makeProject();
    const pid = project._id;

    await Version.create({
      projectId: pid,
      version: 1,
      ipsSnapshot: project.ips,
      configSnapshot: generationConfig,
    });
    await Artifact.create({ projectId: pid, artifactType: 'zod', version: 1 });
    await Job.create({
      projectId: pid,
      version: 1,
      type: 'full',
      requestedArtifacts: ['zod'],
      idempotencyKey: 'k1',
    });
    await MockStore.create({ projectId: pid, entity: 'customer', records: [] });
    await ApiLog.create({ projectId: pid, method: 'GET', path: '/x', status: 200, at: new Date() });

    await hardDeleteProject(String(pid));

    expect(await Project.countDocuments({ _id: pid })).toBe(0);
    expect(await Version.countDocuments({ projectId: pid })).toBe(0);
    expect(await Artifact.countDocuments({ projectId: pid })).toBe(0);
    expect(await Job.countDocuments({ projectId: pid })).toBe(0);
    expect(await MockStore.countDocuments({ projectId: pid })).toBe(0);
    expect(await ApiLog.countDocuments({ projectId: pid })).toBe(0);
  });

  it('leaves other projects untouched', async () => {
    const doomed = await makeProject();
    const survivor = await makeProject();
    await Artifact.create({ projectId: survivor._id, artifactType: 'zod', version: 1 });

    await hardDeleteProject(String(doomed._id));

    expect(await Project.countDocuments({ _id: survivor._id })).toBe(1);
    expect(await Artifact.countDocuments({ projectId: survivor._id })).toBe(1);
  });
});

describe('ensurePublicIdentity (doc 19 §Phase 3)', () => {
  it('mints a prefixed public id and a slug derived from the name', async () => {
    const project = await makeProject({ name: 'Student ERP' });
    await ensurePublicIdentity(project);
    expect(project.publicId).toMatch(/^prj_[0-9a-f]{10}$/);
    expect(project.slug).toBe('student-erp');
  });

  it('uses the sng_ prefix for single APIs', async () => {
    const project = await makeProject({ name: 'Weather API', kind: 'single' });
    await ensurePublicIdentity(project);
    expect(project.publicId).toMatch(/^sng_[0-9a-f]{10}$/);
  });

  it('is idempotent — a second call changes nothing', async () => {
    const project = await makeProject({ name: 'Stable' });
    await ensurePublicIdentity(project);
    const first = { publicId: project.publicId, slug: project.slug };
    await ensurePublicIdentity(project);
    expect({ publicId: project.publicId, slug: project.slug }).toEqual(first);
  });

  it('suffixes the slug when the owner already uses it', async () => {
    const ownerId = new Types.ObjectId();
    const first = await makeProject({ ownerId, name: 'CRM Backend' });
    await ensurePublicIdentity(first);
    expect(first.slug).toBe('crm-backend');

    const second = await makeProject({ ownerId, name: 'CRM Backend' });
    await ensurePublicIdentity(second);
    expect(second.slug).toBe('crm-backend-2');
  });

  it('lets two different owners share a slug', async () => {
    const a = await makeProject({ ownerId: new Types.ObjectId(), name: 'Shop' });
    const b = await makeProject({ ownerId: new Types.ObjectId(), name: 'Shop' });
    await ensurePublicIdentity(a);
    await ensurePublicIdentity(b);
    expect(a.slug).toBe('shop');
    expect(b.slug).toBe('shop');
  });

  it('falls back when the name has no usable characters', async () => {
    const project = await makeProject({ name: '!!!' });
    await ensurePublicIdentity(project);
    expect(project.slug).toBe('api');
  });

  it('preserves a slug that was set explicitly', async () => {
    const project = await makeProject({ name: 'Student ERP', slug: 'my-erp' });
    await ensurePublicIdentity(project);
    expect(project.slug).toBe('my-erp');
  });

  /**
   * The partial filter on the unique index is load-bearing: every project written
   * before slugs existed carries publicId/slug = null, and a plain unique index
   * would reject the second such document.
   */
  it('tolerates many projects with no public identity at all', async () => {
    await Project.syncIndexes();
    const ownerId = new Types.ObjectId();
    await makeProject({ ownerId, name: 'One' });
    await makeProject({ ownerId, name: 'Two' });
    await makeProject({ ownerId, name: 'Three' });
    expect(await Project.countDocuments({ publicId: null })).toBe(3);
  });

  it('enforces global uniqueness on publicId', async () => {
    await Project.syncIndexes();
    await makeProject({ name: 'A', publicId: 'prj_1111111111' });
    await expect(makeProject({ name: 'B', publicId: 'prj_1111111111' })).rejects.toThrow();
  });
});

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
import { findExpiredProjects, expireProjectInDB, hardDeleteProject } from './queries.js';

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

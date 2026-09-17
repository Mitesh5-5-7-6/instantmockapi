/**
 * The unknown-field policy, over a real hosted request.
 *
 * `validate.test.ts` pins the collect/prune functions. This pins what a caller
 * actually experiences: the exact scenario that started this — a `POST` carrying
 * a key the schema never declared — answered three different ways by three
 * projects, and answered the old way by a project staged without the setting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { Artifact, MockStore, Project, User, connectDB, disconnectDB } from '@instantmockapi/db';
import { artifactKey, createMemoryStorage, type MemoryStorage } from '@instantmockapi/storage';
import { generateHostingConfig } from '@instantmockapi/generator-hosting';
import type { InternalProjectSchema, UnknownFieldPolicy } from '@instantmockapi/ips';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { createMemoryCache } from './cache.js';
import { buildMockRuntime } from './server.js';

let mongod: MongoMemoryServer;
let app: FastifyInstance;
const storage: MemoryStorage = createMemoryStorage();
const cache = createMemoryCache();
const baseConfig: EnvConfig = loadEnvConfig();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
  app = await buildMockRuntime({ config: baseConfig, storage, cache, rateLimit: false });
});

afterAll(async () => {
  await app.close();
  await disconnectDB();
  await mongod.stop();
});

beforeEach(async () => {
  storage.clear();
  cache.clear();
  await Promise.all([User, Project, Artifact, MockStore].map((model) => model.deleteMany({})));
});

/**
 * A project whose `Todo` entity declares exactly the three fields from the
 * report — `id`, `title`, `status` — and nothing else.
 */
function makeIps(projectId: string, unknownFields?: UnknownFieldPolicy): InternalProjectSchema {
  const field = (
    name: string,
    type: string,
    required: boolean,
  ): InternalProjectSchema['entities'][number]['fields'][number] =>
    ({ name, type, required, default: null, children: [], validation: {}, meta: {} }) as never;

  return {
    projectId,
    version: 1,
    entities: [
      {
        name: 'Todo',
        fields: [
          field('id', 'uuid', false),
          field('title', 'string', true),
          field('status', 'boolean', true),
          {
            ...field('detail', 'object', false),
            children: [field('note', 'string', false)],
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod'],
      types: [],
      methods: ['GET', 'POST', 'PUT', 'PATCH'],
      mockRecords: 1,
      // Omitted entirely when not asked for, which is how a project generated
      // before the setting existed reaches the runtime.
      ...(unknownFields ? { unknownFields } : {}),
    },
  } as InternalProjectSchema;
}

async function stage(unknownFields?: UnknownFieldPolicy): Promise<string> {
  const user = await User.create({
    email: `owner-${Math.random().toString(36).slice(2)}@x.dev`,
    authProvider: 'email',
  });
  const project = new Project({
    ownerId: user._id,
    name: 'Todo App',
    status: 'active',
    inputSource: { type: 'json', raw: '{}' },
    currentVersion: 1,
    hosted: {
      url: 'https://api.instantmockapi.dev/p/x',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const ips = makeIps(String(project._id), unknownFields);
  project.ips = ips;
  project.generationConfig = ips.generationConfig;
  await project.save();
  const projectId = String(project._id);

  const ref = artifactKey(projectId, 1, 'hosted_api', 'hosting.config.json');
  await storage.put(
    ref,
    generateHostingConfig(ips)['hosting.config.json'] ?? '{}',
    'application/json',
  );
  await Artifact.create({
    projectId: project._id,
    artifactType: 'hosted_api',
    version: 1,
    status: 'completed',
    storageRef: ref,
    generatedAt: new Date(),
    workerId: 'F',
  });
  await MockStore.create({ projectId: project._id, entity: 'todo', records: [] });
  return projectId;
}

const BODY = { title: 'mock api for todo app', status: true, ajs: 'dwe' };

describe('POST carrying a field the schema never declared', () => {
  it('allow — 201, the key is stored and echoed back', async () => {
    const projectId = await stage('allow');
    const res = await app.inject({ method: 'POST', url: `/p/${projectId}/todo`, payload: BODY });

    expect(res.statusCode).toBe(201);
    expect(res.json().ajs).toBe('dwe');

    // Stored, not merely reflected: a later GET still has it.
    const read = await app.inject({ method: 'GET', url: `/p/${projectId}/todo` });
    expect(read.json().data[0].ajs).toBe('dwe');
  });

  it('strip — 201, the request succeeds and the key is gone', async () => {
    const projectId = await stage('strip');
    const res = await app.inject({ method: 'POST', url: `/p/${projectId}/todo`, payload: BODY });

    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('ajs');
    expect(res.json()).toMatchObject({ title: 'mock api for todo app', status: true });

    const read = await app.inject({ method: 'GET', url: `/p/${projectId}/todo` });
    expect(read.json().data[0]).not.toHaveProperty('ajs');
  });

  it('reject — 422 naming the field, and nothing is stored', async () => {
    const projectId = await stage('reject');
    const res = await app.inject({ method: 'POST', url: `/p/${projectId}/todo`, payload: BODY });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toContainEqual({
      path: 'ajs',
      issue: 'is not a field of this entity',
    });

    const read = await app.inject({ method: 'GET', url: `/p/${projectId}/todo` });
    expect(read.json().data).toHaveLength(0);
  });

  it('a config generated before the setting existed keeps storing it', async () => {
    // The compatibility guarantee. Every live project is in this state until it
    // is regenerated, and none of them may start behaving differently.
    const projectId = await stage();
    const res = await app.inject({ method: 'POST', url: `/p/${projectId}/todo`, payload: BODY });

    expect(res.statusCode).toBe(201);
    expect(res.json().ajs).toBe('dwe');
  });
});

describe('the policy applies to every write verb', () => {
  it('rejects an undeclared key on PUT and PATCH, not just POST', async () => {
    // One helper serves all three precisely so they cannot diverge — an API that
    // refuses a key on POST and stores it on PATCH is worse than either rule.
    const projectId = await stage('reject');
    const created = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/todo`,
      payload: { title: 'first', status: false },
    });
    const id = created.json().id;

    const put = await app.inject({
      method: 'PUT',
      url: `/p/${projectId}/todo/${id}`,
      payload: { title: 'second', status: true, ajs: 'dwe' },
    });
    expect(put.statusCode).toBe(422);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/p/${projectId}/todo/${id}`,
      payload: { ajs: 'dwe' },
    });
    expect(patch.statusCode).toBe(422);
  });

  it('reaches nested objects, not just the top level', async () => {
    const projectId = await stage('reject');
    const res = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/todo`,
      payload: { title: 'nested', status: true, detail: { note: 'ok', extra: 1 } },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toContainEqual({
      path: 'detail.extra',
      issue: 'is not a field of this entity',
    });
  });

  it('keeps already-stored extra keys through a PATCH after switching to strip', async () => {
    // `strip` governs what a write adds. Deleting data the caller never
    // mentioned would make PATCH destructive; PUT is the verb that replaces.
    const projectId = await stage('allow');
    const created = await app.inject({
      method: 'POST',
      url: `/p/${projectId}/todo`,
      payload: BODY,
    });
    expect(created.json().ajs).toBe('dwe');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/p/${projectId}/todo/${created.json().id}`,
      payload: { title: 'renamed' },
    });
    expect(patched.json()).toMatchObject({ title: 'renamed', ajs: 'dwe' });
  });
});

describe('the discovery document', () => {
  it('advertises the policy, so a caller need not discover it by experiment', async () => {
    const projectId = await stage('reject');
    const res = await app.inject({ method: 'GET', url: `/p/${projectId}` });

    expect(res.json().data.unknownFields).toBe('reject');
  });
});

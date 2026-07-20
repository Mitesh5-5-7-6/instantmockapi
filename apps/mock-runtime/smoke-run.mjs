// Temporary smoke: boot the built mock runtime over real HTTP against an
// in-memory MongoDB, staged exactly as the worker pipeline leaves a hosted
// project. Deleted after the check.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB, User, Project, Artifact, MockStore } from '@instantmockapi/db';
import { artifactKey, createMemoryStorage } from '@instantmockapi/storage';
import { generateHostingConfig } from '@instantmockapi/generator-hosting';
import { createMemoryCache } from './dist/cache.js';
import { buildMockRuntime } from './dist/server.js';
import fetch from 'node-fetch';

const mongod = await MongoMemoryServer.create();
await connectDB(mongod.getUri());

const storage = createMemoryStorage();
const cache = createMemoryCache();

const user = await User.create({ email: 'smoke@host.dev', authProvider: 'email' });
const project = new Project({
  ownerId: user._id,
  name: 'Hosted Smoke',
  status: 'active',
  inputSource: { type: 'json', raw: '{}' },
  currentVersion: 1,
  hosted: { url: 'x', expiresAt: new Date(Date.now() + 86_400_000) },
});
const ips = {
  projectId: String(project._id),
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
          meta: {},
        },
        {
          name: 'name',
          type: 'string',
          required: true,
          default: '',
          children: [],
          validation: { min: 2 },
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
      ],
    },
  ],
  generationConfig: { validators: ['zod'], types: [], methods: ['GET', 'POST'], mockRecords: 2 },
};
project.ips = ips;
project.generationConfig = ips.generationConfig;
await project.save();
const projectId = String(project._id);

const ref = artifactKey(projectId, 1, 'hosted_api', 'hosting.config.json');
await storage.put(ref, generateHostingConfig(ips)['hosting.config.json'], 'application/json');
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
  entity: 'customer',
  records: [{ id: 'c-1', name: 'Ada', email: 'ada@example.com' }],
});

const app = await buildMockRuntime({ storage, cache });
const address = await app.listen({ port: 4001, host: '127.0.0.1' });

export const list = await fetch(`${address}/p/${projectId}/customer`);

export const create = await fetch(`${address}/p/${projectId}/customer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Grace Hopper', email: 'grace@example.com' }),
});

export const invalid = await fetch(`${address}/p/${projectId}/customer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'G', email: 'nope' }),
});

export const notAllowed = await fetch(`${address}/p/${projectId}/customer/c-1`, {
  method: 'DELETE',
});

await app.close();
await disconnectDB();
await mongod.stop();

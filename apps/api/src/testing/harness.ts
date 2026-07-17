/**
 * Shared test harness: in-memory Mongo, server construction with a fixed JWT
 * secret and rate limiting off, and login/request helpers.
 *
 * Test files must `vi.mock('@instantmockapi/queue')` themselves (hoisting is
 * per-file) so no Redis connection is ever attempted.
 */

import type { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import {
  ApiLog,
  Artifact,
  Job,
  MockStore,
  Project,
  User,
  Version,
  connectDB,
  disconnectDB,
} from '@instantmockapi/db';
import { buildServer, type BuildServerOptions } from '../server.js';

export const testConfig: EnvConfig = { ...loadEnvConfig(), jwtSecret: 'api-test-secret' };

let mongod: MongoMemoryServer | null = null;

export async function startTestDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
}

export async function stopTestDb(): Promise<void> {
  await disconnectDB();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function clearDb(): Promise<void> {
  await Promise.all(
    [User, Project, Version, Artifact, Job, MockStore, ApiLog].map((model) => model.deleteMany({})),
  );
}

export function buildTestServer(overrides: BuildServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({ config: testConfig, rateLimit: false, ...overrides });
}

export interface TestSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export async function login(app: FastifyInstance, email: string): Promise<TestSession> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email } });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as {
    accessToken: string;
    refreshToken: string;
    user: { id: string };
  };
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, userId: body.user.id };
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Simple JSON payload the json-adapter can infer an entity from. */
export const sampleRaw = {
  customer: { name: 'Ada Lovelace', email: 'ada@example.com', age: 36 },
};

export async function createProjectViaApi(
  app: FastifyInstance,
  token: string,
  name = 'CRM Backend',
) {
  return app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: authHeader(token),
    payload: { name, inputSource: { type: 'json', raw: sampleRaw } },
  });
}

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
import { createMemoryStorage, type MemoryStorage } from '@instantmockapi/storage';
import {
  ApiLog,
  Artifact,
  AuthToken,
  Job,
  MockStore,
  Project,
  User,
  Version,
  connectDB,
  disconnectDB,
} from '@instantmockapi/db';
import { buildServer, type BuildServerOptions } from '../server.js';
import type { Mailer } from '../email.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE, REFRESH_COOKIE } from '../auth-cookies.js';

export { REFRESH_COOKIE };

export const testConfig: EnvConfig = { ...loadEnvConfig(), jwtSecret: 'api-test-secret' };

/** Shared in-memory object storage; cleared by clearDb(). */
export const testStorage: MemoryStorage = createMemoryStorage();

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
  testStorage.clear();
  await Promise.all(
    [User, AuthToken, Project, Version, Artifact, Job, MockStore, ApiLog].map((model) =>
      model.deleteMany({}),
    ),
  );
}

/**
 * A mailer that keeps every message instead of sending it.
 *
 * Tests read the link out of `message.text` exactly as a developer reads it out
 * of the terminal, so what is asserted is what a real recipient would receive —
 * not an internal token handed back through a side channel.
 */
export interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface CapturingMailer extends Mailer {
  sent: CapturedMail[];
  /** The most recent message to an address, or undefined. */
  lastTo(email: string): CapturedMail | undefined;
  /** The `?token=` value from the most recent message to an address. */
  tokenFor(email: string): string;
  clear(): void;
}

export function createCapturingMailer(): CapturingMailer {
  const sent: CapturedMail[] = [];
  return {
    kind: 'log',
    sent,
    async send(message) {
      sent.push({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    lastTo(email) {
      return [...sent].reverse().find((message) => message.to === email);
    },
    tokenFor(email) {
      const message = [...sent].reverse().find((item) => item.to === email);
      if (!message) {
        throw new Error(`no email was sent to ${email}`);
      }
      const match = /[?&]token=([^\s&]+)/.exec(message.text);
      if (!match?.[1]) {
        throw new Error(`no token in the email to ${email}: ${message.text}`);
      }
      return match[1];
    },
    clear() {
      sent.length = 0;
    },
  };
}

/**
 * A mailer that always fails, for the misconfiguration cases — an unverified
 * sending domain, a rejected API key. What matters about these is not that the
 * send fails but *what the endpoint answers* when it does.
 */
export function createFailingMailer(): Mailer {
  return {
    kind: 'resend',
    async send() {
      throw new Error('Email send failed with status 422');
    },
  };
}
export function buildTestServer(overrides: BuildServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({ config: testConfig, rateLimit: false, storage: testStorage, ...overrides });
}

export interface TestSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/**
 * Sign in without a password, via the development-only route.
 *
 * The real `/v1/auth/login` needs a password, an existing account and a verified
 * address; every fixture user in this suite would otherwise cost an scrypt hash
 * at 64MB and an email round trip. `/auth/dev-login` is not registered when
 * `nodeEnv` is production, so this cannot be a way in anywhere real.
 */
export async function login(app: FastifyInstance, email: string): Promise<TestSession> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { email } });
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

/**
 * The header every cookie-authenticated route requires.
 *
 * A browser cannot send it cross-origin without passing a CORS preflight, which
 * is the whole CSRF defence (see auth-cookies.ts). Tests reach the routes
 * directly, so they have to supply it explicitly.
 */
export function csrfHeader(): Record<string, string> {
  return { [CSRF_HEADER]: CSRF_HEADER_VALUE };
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

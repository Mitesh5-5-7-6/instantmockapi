import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
    enqueueGenerationJob: vi.fn(async (...args: unknown[]) => ({ id: args[4] })),
    enqueueAiProposalJob: vi.fn(async () => ({ id: 'job' })),
  };
});

import type { FastifyInstance } from 'fastify';
import { enqueueAiProposalJob } from '@instantmockapi/queue';
import { AiProposal } from '@instantmockapi/db';
import { fakeOutputJson } from '@instantmockapi/ai';
import {
  authHeader,
  buildTestServer,
  clearDb,
  login,
  startTestDb,
  stopTestDb,
  testConfig,
  type TestSession,
} from '../testing/harness.js';

let app: FastifyInstance;
let alice: TestSession;
let bob: TestSession;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer({ config: { ...testConfig, geminiApiKey: 'test-key' } });
});
afterAll(async () => {
  await app.close();
  await stopTestDb();
});
beforeEach(async () => {
  await clearDb();
  vi.mocked(enqueueAiProposalJob).mockClear();
  alice = await login(app, 'alice@example.com');
  bob = await login(app, 'bob@example.com');
});

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: authHeader(token) });
}

const AUTH_ALL = {
  mode: 'ALL_PROTECTED',
  signup: true,
  signin: true,
  refreshToken: true,
  cookieAuth: false,
  accessTokenExpiresIn: '15m',
  refreshTokenExpiresIn: '7d',
  userFields: [],
};

function patch(url: string, token: string, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: authHeader(token),
    payload: payload as Record<string, unknown>,
  });
}

async function seedReady(ownerId: string, extra: Record<string, unknown> = {}) {
  return AiProposal.create({
    ownerId,
    prompt: 'any API',
    model: 'test',
    promptVersion: 'generic-v2',
    status: 'ready',
    stage: null,
    result: JSON.parse(fakeOutputJson(['Alpha', 'Beta'])),
    ...extra,
  });
}

function draftBody(over: Record<string, unknown> = {}) {
  const result = JSON.parse(fakeOutputJson(['Alpha', 'Beta']));
  return {
    revision: 0,
    kind: 'project',
    name: 'My API',
    description: 'desc',
    entities: result.entities,
    generationConfig: { methods: ['GET', 'POST'], mockRecords: 20 },
    authAnswered: false,
    authentication: null,
    ...over,
  };
}

describe('PATCH /v1/ai/proposals/:id/draft', () => {
  it('saves a first draft with revision 1 and no issues', async () => {
    const doc = await seedReady(alice.userId);
    const res = await patch(`/v1/ai/proposals/${doc._id}/draft`, alice.accessToken, draftBody());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      draft: { revision: 1, name: 'My API', authAnswered: false },
      issues: [],
    });
  });

  it('saves even when the schema is invalid, and returns the issues', async () => {
    const doc = await seedReady(alice.userId);
    const res = await patch(
      `/v1/ai/proposals/${doc._id}/draft`,
      alice.accessToken,
      draftBody({
        entities: [{ name: 'Bad', fields: [{ name: 'id', type: 'nonsense' }] }],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect((await AiProposal.findById(doc._id).lean())!.draft).not.toBeNull();
  });

  it('answers 409 with the current draft when the revision is stale (another tab)', async () => {
    const doc = await seedReady(alice.userId);
    await patch(`/v1/ai/proposals/${doc._id}/draft`, alice.accessToken, draftBody());
    const stale = await patch(
      `/v1/ai/proposals/${doc._id}/draft`,
      alice.accessToken,
      draftBody({ name: 'Other tab' }),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().draft).toMatchObject({ revision: 1, name: 'My API' });
  });

  it('answers 409 when the proposal is no longer ready', async () => {
    const doc = await seedReady(alice.userId, { status: 'committed' });
    const res = await patch(`/v1/ai/proposals/${doc._id}/draft`, alice.accessToken, draftBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.status).toBe('committed');
  });

  it('bumps the revision on each save and rejects a repeat of a stale one', async () => {
    const url = `/v1/ai/proposals/${(await seedReady(alice.userId))._id}/draft`;
    const first = await patch(url, alice.accessToken, draftBody({ revision: 0 }));
    expect(first.json().draft.revision).toBe(1);
    const second = await patch(url, alice.accessToken, draftBody({ revision: 1 }));
    expect(second.statusCode).toBe(200);
    expect(second.json().draft.revision).toBe(2);
    const stale = await patch(url, alice.accessToken, draftBody({ revision: 1 }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().draft.revision).toBe(2);
  });

  it('is owner-scoped', async () => {
    const doc = await seedReady(alice.userId);
    expect(
      (await patch(`/v1/ai/proposals/${doc._id}/draft`, bob.accessToken, draftBody())).statusCode,
    ).toBe(404);
  });

  it('keeps per-entity auth stamps and validates the auth config', async () => {
    const doc = await seedReady(alice.userId);
    const result = JSON.parse(fakeOutputJson(['Alpha', 'Beta']));
    const res = await patch(
      `/v1/ai/proposals/${doc._id}/draft`,
      alice.accessToken,
      draftBody({
        authAnswered: true,
        authentication: { ...AUTH_ALL, mode: 'COMBINATION' },
        entities: [
          { ...result.entities[0], authentication: 'PROTECTED' },
          { ...result.entities[1], authentication: 'PUBLIC' },
        ],
      }),
    );
    expect(res.json().issues).toEqual([]);
    expect(
      res.json().draft.entities.map((e: { authentication?: string }) => e.authentication),
    ).toEqual(['PROTECTED', 'PUBLIC']);
  });

  it('coerces an out-of-range mockRecords', async () => {
    const doc = await seedReady(alice.userId);
    const res = await patch(
      `/v1/ai/proposals/${doc._id}/draft`,
      alice.accessToken,
      draftBody({ generationConfig: { methods: ['GET'], mockRecords: 50_000 } }),
    );
    expect(res.json().draft.generationConfig.mockRecords).toBe(testConfig.defaultMockRecords);
  });

  it('exposes the draft on GET', async () => {
    const doc = await seedReady(alice.userId);
    await patch(`/v1/ai/proposals/${doc._id}/draft`, alice.accessToken, draftBody());
    expect((await get(`/v1/ai/proposals/${doc._id}`, alice.accessToken)).json()).toMatchObject({
      draft: { revision: 1 },
      translation: null,
      childId: null,
    });
  });

  it('expires a translation by its own requestedAt, even after recent autosaves', async () => {
    const doc = await seedReady(alice.userId, {
      translation: {
        status: 'pending',
        language: 'gu',
        requestedAt: new Date(Date.now() - 11 * 60_000),
      },
    });
    expect(
      (await get(`/v1/ai/proposals/${doc._id}`, alice.accessToken)).json().translation,
    ).toMatchObject({ status: 'failed', language: 'gu' });
  });

  it('keeps a recently requested translation pending despite an old updatedAt', async () => {
    const doc = await seedReady(alice.userId, {
      translation: {
        status: 'pending',
        language: 'gu',
        requestedAt: new Date(Date.now() - 60_000),
      },
    });
    await AiProposal.collection.updateOne(
      { _id: doc._id },
      { $set: { updatedAt: new Date(Date.now() - 11 * 60_000) } },
    );
    expect(
      (await get(`/v1/ai/proposals/${doc._id}`, alice.accessToken)).json().translation,
    ).toMatchObject({ status: 'pending' });
  });
});

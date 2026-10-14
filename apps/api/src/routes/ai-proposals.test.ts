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
// `mongoose` is not a dependency of apps/api; use the instance the db package re-exports.
import { AiProposal, Project, mongoose } from '@instantmockapi/db';

const { Types } = mongoose;
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

function post(url: string, token: string, payload: unknown = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: authHeader(token),
    payload: payload as Record<string, unknown>,
  });
}
function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: authHeader(token) });
}

async function seed(ownerId: string, extra: Record<string, unknown> = {}) {
  return AiProposal.create({
    ownerId,
    prompt: 'any API',
    model: 'test',
    promptVersion: 'generic-v1',
    status: 'ready',
    stage: null,
    result: JSON.parse(fakeOutputJson(['Alpha', 'Beta'])),
    ...extra,
  });
}

describe('POST /v1/ai/proposals', () => {
  it('stores the proposal, enqueues run 1, and answers 202', async () => {
    const res = await post('/v1/ai/proposals', alice.accessToken, {
      prompt: '  gym membership API  ',
      kind: 'single',
      responseLanguage: 'gu',
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'generating',
      stage: 'queued',
      prompt: 'gym membership API',
      hints: { kind: 'single' },
      responseLanguage: 'gu',
    });
    expect(enqueueAiProposalJob).toHaveBeenCalledWith(body.id, 1);
  });

  it('rejects a whitespace-only prompt without storing or queueing (Review Focus #3)', async () => {
    const res = await post('/v1/ai/proposals', alice.accessToken, { prompt: '   \n  ' });
    expect(res.statusCode).toBe(422);
    expect(await AiProposal.countDocuments()).toBe(0);
    expect(enqueueAiProposalJob).not.toHaveBeenCalled();
  });

  it('rejects auth as a requested kind', async () => {
    expect(
      (await post('/v1/ai/proposals', alice.accessToken, { prompt: 'x', kind: 'auth' })).statusCode,
    ).toBe(400);
  });

  it('answers 503 AI_NOT_CONFIGURED when the API has no key', async () => {
    const keyless = await buildTestServer({ config: { ...testConfig, geminiApiKey: '' } });
    const session = await login(keyless, 'carol@example.com');
    const res = await keyless.inject({
      method: 'POST',
      url: '/v1/ai/proposals',
      headers: authHeader(session.accessToken),
      payload: { prompt: 'x' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    await keyless.close();
  });

  it('marks the proposal failed and answers 503 when the queue is unreachable', async () => {
    vi.mocked(enqueueAiProposalJob).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await post('/v1/ai/proposals', alice.accessToken, { prompt: 'x' });
    expect(res.statusCode).toBe(503);
    const stored = await AiProposal.findOne().lean();
    expect(stored).toMatchObject({ status: 'failed', prompt: 'x' });
    expect(res.body).not.toContain('ECONNREFUSED');
  });
});

describe('reading proposals', () => {
  it('returns the owner their proposal and 404 to anyone else or for a malformed id', async () => {
    const doc = await seed(alice.userId);
    expect(
      (await get(`/v1/ai/proposals/${doc._id}`, alice.accessToken)).json().result.entities,
    ).toHaveLength(2);
    expect((await get(`/v1/ai/proposals/${doc._id}`, bob.accessToken)).statusCode).toBe(404);
    expect((await get('/v1/ai/proposals/not-an-id', alice.accessToken)).statusCode).toBe(404);
  });

  it('marks a proposal stuck in generating for over 10 minutes as failed when read', async () => {
    const doc = await seed(alice.userId, {
      status: 'generating',
      stage: 'generating',
      result: null,
    });
    await AiProposal.collection.updateOne(
      { _id: doc._id },
      { $set: { updatedAt: new Date(Date.now() - 11 * 60_000) } },
    );
    const body = (await get(`/v1/ai/proposals/${doc._id}`, alice.accessToken)).json();
    expect(body).toMatchObject({ status: 'failed', stage: null });
    expect(body.error.message).toMatch(/timed out/i);
  });

  it('lists only the caller’s proposals, newest first', async () => {
    const older = await seed(alice.userId, { prompt: 'older' });
    await AiProposal.collection.updateOne(
      { _id: older._id },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );
    await seed(alice.userId, { prompt: 'newer' });
    await seed(bob.userId, { prompt: 'bob' });
    const body = (await get('/v1/ai/proposals', alice.accessToken)).json();
    expect(body.data.map((p: { prompt: string }) => p.prompt)).toEqual(['newer', 'older']);
    expect(body.data[0]).toMatchObject({ name: 'Test API', status: 'ready' });
    expect(body.meta.total).toBe(2);
  });
});

describe('retry and cancel', () => {
  it('retries only a failed proposal, as a new run', async () => {
    const failed = await seed(alice.userId, {
      status: 'failed',
      result: null,
      error: { code: 'AI_GENERATION_FAILED', message: 'm', details: [] },
    });
    const res = await post(`/v1/ai/proposals/${failed._id}/retry`, alice.accessToken);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'generating', stage: 'queued', error: null });
    expect(enqueueAiProposalJob).toHaveBeenCalledWith(String(failed._id), 2);

    const ready = await seed(alice.userId);
    expect((await post(`/v1/ai/proposals/${ready._id}/retry`, alice.accessToken)).statusCode).toBe(
      409,
    );
  });

  it('cancels a generating or ready proposal, not a committed one', async () => {
    const doc = await seed(alice.userId, { status: 'generating', result: null });
    const res = await post(`/v1/ai/proposals/${doc._id}/cancel`, alice.accessToken);
    expect(res.json().status).toBe('cancelled');
    const committed = await seed(alice.userId, { status: 'committed' });
    expect(
      (await post(`/v1/ai/proposals/${committed._id}/cancel`, alice.accessToken)).statusCode,
    ).toBe(409);
  });
});

describe('commit', () => {
  it('creates a project, preferring the user kind hint over the recommendation', async () => {
    const doc = await seed(alice.userId, { hints: { kind: 'single' } });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project).toMatchObject({ name: 'Test API', kind: 'single' });
    const stored = await AiProposal.findById(doc._id).lean();
    expect(stored).toMatchObject({ status: 'committed' });
    expect(String(stored!.projectId)).toBe(project.id);
  });

  it('lets the commit body override kind and name', async () => {
    const doc = await seed(alice.userId, { hints: { kind: 'single' } });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      kind: 'project',
      name: 'Renamed',
    });
    expect(res.json()).toMatchObject({ kind: 'project', name: 'Renamed' });
  });

  it('answers 422 for an invalid edited blueprint and returns the proposal to ready', async () => {
    const doc = await seed(alice.userId);
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      blueprint: { entities: [{ name: 'Bad', fields: [{ name: 'id', type: 'nonsense' }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('ready');
    expect(await Project.countDocuments()).toBe(0);
  });

  it('creates exactly one project when two commits race', async () => {
    const doc = await seed(alice.userId);
    const results = await Promise.all([
      post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken),
      post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await Project.countDocuments()).toBe(1);
  });

  it('answers 409 with the projectId when already committed', async () => {
    const projectId = new Types.ObjectId();
    const doc = await seed(alice.userId, { status: 'committed', projectId });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.projectId).toBe(String(projectId));
  });

  it('answers 409 and creates nothing for a cancelled proposal (Review Focus #5)', async () => {
    const doc = await seed(alice.userId, { status: 'cancelled' });
    expect((await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken)).statusCode).toBe(
      409,
    );
    expect(await Project.countDocuments()).toBe(0);
  });

  it('does not duplicate the project when the committed write fails after creation', async () => {
    const doc = await seed(alice.userId);
    const spy = vi.spyOn(AiProposal, 'updateOne').mockRejectedValueOnce(new Error('mongo blip'));
    const first = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    spy.mockRestore();
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    expect(await Project.countDocuments()).toBe(1);
    expect((await AiProposal.findById(doc._id).lean())!.status).not.toBe('ready');
    const second = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(second.statusCode).toBe(409);
    expect(await Project.countDocuments()).toBe(1);
  });

  it('rejects a malformed slug and creates nothing', async () => {
    const doc = await seed(alice.userId);
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      slug: 'Not A Slug',
    });
    expect(res.statusCode).toBe(400);
    expect(await Project.countDocuments()).toBe(0);
  });

  it('caps a long prompt used as the description fallback', async () => {
    const result = JSON.parse(fakeOutputJson(['Alpha']));
    result.description = '';
    const doc = await seed(alice.userId, { prompt: 'p'.repeat(900), result });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const stored = await Project.findOne().lean();
    expect(stored!.description!.length).toBeLessThanOrEqual(500);
  });

  it('cannot commit another user’s proposal', async () => {
    const doc = await seed(alice.userId);
    expect((await post(`/v1/ai/proposals/${doc._id}/commit`, bob.accessToken)).statusCode).toBe(
      404,
    );
  });
});

it('no longer serves the old one-step endpoint', async () => {
  expect((await post('/v1/projects/ai', alice.accessToken, { prompt: 'x' })).statusCode).toBe(404);
});

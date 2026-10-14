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
import { getPlanConfig } from '@instantmockapi/config';
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

function readyDraft(over: Record<string, unknown> = {}) {
  const result = JSON.parse(fakeOutputJson(['Alpha', 'Beta']));
  return {
    revision: 1,
    kind: 'project',
    name: 'Test API',
    description: 'test description',
    entities: result.entities,
    generationConfig: { methods: ['GET', 'POST', 'PATCH', 'DELETE'], mockRecords: 20 },
    authAnswered: true,
    authentication: null,
    savedAt: new Date(),
    ...over,
  };
}

const AUTH = (mode: string) => ({
  mode,
  signup: true,
  signin: true,
  refreshToken: true,
  cookieAuth: false,
  accessTokenExpiresIn: '15m',
  refreshTokenExpiresIn: '7d',
  userFields: [],
});

async function seed(ownerId: string, extra: Record<string, unknown> = {}) {
  return AiProposal.create({
    ownerId,
    prompt: 'any API',
    model: 'test',
    promptVersion: 'generic-v1',
    status: 'ready',
    stage: null,
    result: JSON.parse(fakeOutputJson(['Alpha', 'Beta'])),
    draft: readyDraft(),
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

describe('hourly AI budget', () => {
  // Two proposals whose runs sum to 20 (12 + 8).
  async function seedBudget(ownerId: string, runStartedAt: Date) {
    await seed(ownerId, { runs: 12, runStartedAt });
    await seed(ownerId, { runs: 8, runStartedAt });
  }

  it('answers 429 at the limit and stores and queues nothing', async () => {
    await seedBudget(alice.userId, new Date());
    const res = await post('/v1/ai/proposals', alice.accessToken, { prompt: 'one more' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(await AiProposal.countDocuments()).toBe(2);
    expect(enqueueAiProposalJob).not.toHaveBeenCalled();
  });

  it('allows it again once the runs are two hours old', async () => {
    await seedBudget(alice.userId, new Date(Date.now() - 2 * 60 * 60_000));
    const res = await post('/v1/ai/proposals', alice.accessToken, { prompt: 'fresh hour' });
    expect(res.statusCode).toBe(202);
  });

  it('refuses a retry at the limit', async () => {
    await seedBudget(alice.userId, new Date());
    const failed = await seed(alice.userId, {
      status: 'failed',
      result: null,
      runs: 0,
      error: { code: 'AI_GENERATION_FAILED', message: 'm', details: [] },
    });
    const res = await post(`/v1/ai/proposals/${failed._id}/retry`, alice.accessToken);
    expect(res.statusCode).toBe(429);
    expect(enqueueAiProposalJob).not.toHaveBeenCalled();
    expect((await AiProposal.findById(failed._id))!.status).toBe('failed');
  });

  it('restarts the hour window for a retried run', async () => {
    const failed = await seed(alice.userId, {
      status: 'failed',
      result: null,
      runStartedAt: new Date(Date.now() - 3 * 60 * 60_000),
      error: { code: 'AI_GENERATION_FAILED', message: 'm', details: [] },
    });
    await post(`/v1/ai/proposals/${failed._id}/retry`, alice.accessToken);
    const stored = await AiProposal.findById(failed._id);
    expect(stored!.runStartedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('does not count another user’s runs', async () => {
    await seedBudget(bob.userId, new Date());
    const res = await post('/v1/ai/proposals', alice.accessToken, { prompt: 'mine' });
    expect(res.statusCode).toBe(202);
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

  it('settles a committing proposal stuck over 2 minutes as failed, and leaves a fresh one', async () => {
    const stuck = await seed(alice.userId, { status: 'committing' });
    const fresh = await seed(alice.userId, { status: 'committing' });
    await AiProposal.collection.updateOne(
      { _id: stuck._id },
      { $set: { updatedAt: new Date(Date.now() - 3 * 60_000) } },
    );
    await AiProposal.collection.updateOne(
      { _id: fresh._id },
      { $set: { updatedAt: new Date(Date.now() - 30_000) } },
    );
    const body = (await get(`/v1/ai/proposals/${stuck._id}`, alice.accessToken)).json();
    expect(body.status).toBe('failed');
    expect(body.error.message).toBe(
      'Project creation was interrupted. Check your projects list before trying again.',
    );
    expect((await get(`/v1/ai/proposals/${fresh._id}`, alice.accessToken)).json().status).toBe(
      'committing',
    );
  });

  it('paginates history: page 2 of limit 1 is the second-newest', async () => {
    const older = await seed(alice.userId, { prompt: 'older' });
    await AiProposal.collection.updateOne(
      { _id: older._id },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );
    await seed(alice.userId, { prompt: 'newer' });
    const body = (await get('/v1/ai/proposals?page=2&limit=1', alice.accessToken)).json();
    expect(body.data.map((p: { prompt: string }) => p.prompt)).toEqual(['older']);
    expect(body.meta).toMatchObject({ page: 2, limit: 1, total: 2 });
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
  it('creates a project from the draft', async () => {
    const doc = await seed(alice.userId, { draft: readyDraft({ kind: 'single' }) });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project).toMatchObject({ name: 'Test API', kind: 'single' });
    const stored = await AiProposal.findById(doc._id).lean();
    expect(stored).toMatchObject({ status: 'committed' });
    expect(String(stored!.projectId)).toBe(project.id);
  });

  it('lets the commit body override kind and name', async () => {
    const doc = await seed(alice.userId, { draft: readyDraft({ kind: 'single' }) });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      kind: 'project',
      name: 'Renamed',
    });
    expect(res.json()).toMatchObject({ kind: 'project', name: 'Renamed' });
  });

  it('ignores a body blueprint and builds from the draft', async () => {
    const doc = await seed(alice.userId);
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      blueprint: { entities: [{ name: 'Bad', fields: [{ name: 'id', type: 'nonsense' }] }] },
    });
    expect(res.statusCode).toBe(201);
    const ips = (await Project.findById(res.json().id).lean())!.ips as {
      entities: { name: string }[];
    };
    expect(ips.entities.map((e) => e.name)).toEqual(
      readyDraft().entities.map((e: { name: string }) => e.name),
    );
  });

  it('keeps the 409 with projectId for a committed proposal that has no draft', async () => {
    const projectId = new Types.ObjectId();
    const doc = await seed(alice.userId, { status: 'committed', projectId, draft: null });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.projectId).toBe(String(projectId));
  });

  it('keeps the 409 for a cancelled proposal that has no draft', async () => {
    const doc = await seed(alice.userId, { status: 'cancelled', draft: null });
    expect((await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken)).statusCode).toBe(
      409,
    );
  });

  it('answers 422 for an invalid draft and returns the proposal to ready', async () => {
    const doc = await seed(alice.userId, {
      draft: readyDraft({
        entities: [{ name: 'Bad', fields: [{ name: 'id', type: 'nonsense' }] }],
      }),
    });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(422);
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('ready');
    expect(await Project.countDocuments()).toBe(0);
  });
  it('rejects an authentication property with 422 and creates no project', async () => {
    const doc = await seed(alice.userId);
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken, {
      authentication: { type: 'none' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('set authentication in the draft');
    expect(await Project.countDocuments()).toBe(0);
  });

  it('refuses to commit without a draft', async () => {
    const doc = await seed(alice.userId, { draft: null });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe('authentication');
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('ready');
    expect(await Project.countDocuments()).toBe(0);
  });

  it('refuses to commit until the authentication question is answered', async () => {
    const doc = await seed(alice.userId, { draft: readyDraft({ authAnswered: false }) });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].path).toBe('authentication');
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('ready');
    expect(await Project.countDocuments()).toBe(0);
  });

  it('creates an ALL_PROTECTED project from the draft auth answer', async () => {
    const doc = await seed(alice.userId, {
      draft: readyDraft({ authentication: AUTH('ALL_PROTECTED') }),
    });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const project = await Project.findById(res.json().id).lean();
    expect((project!.ips as { authentication?: { mode: string } }).authentication?.mode).toBe(
      'ALL_PROTECTED',
    );
  });

  it('creates a COMBINATION project with the per-entity stamps', async () => {
    const result = JSON.parse(fakeOutputJson(['Alpha', 'Beta']));
    const doc = await seed(alice.userId, {
      draft: readyDraft({
        authentication: AUTH('COMBINATION'),
        entities: [
          { ...result.entities[0], authentication: 'PROTECTED' },
          { ...result.entities[1], authentication: 'PUBLIC' },
        ],
      }),
    });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const ips = (await Project.findById(res.json().id).lean())!.ips as {
      entities: { name: string; authentication?: string }[];
    };
    expect(ips.entities.map((e) => e.authentication)).toEqual(['PROTECTED', 'PUBLIC']);
  });

  it('keeps entity descriptions from the draft in the created project (Review Focus #5)', async () => {
    const result = JSON.parse(fakeOutputJson(['Alpha']));
    const doc = await seed(alice.userId, {
      draft: readyDraft({ entities: [{ ...result.entities[0], description: 'Alpha things' }] }),
    });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    const ips = (await Project.findById(res.json().id).lean())!.ips as {
      entities: { description?: string }[];
    };
    expect(ips.entities[0]!.description).toBe('Alpha things');
  });

  it('does not 500 when the commit body is a JSON primitive', async () => {
    const doc = await seed(alice.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/ai/proposals/${doc._id}/commit`,
      headers: { ...authHeader(alice.accessToken), 'content-type': 'application/json' },
      payload: '"abc"',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
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
    const doc = await seed(alice.userId, {
      prompt: 'p'.repeat(900),
      result,
      draft: readyDraft({ description: '' }),
    });
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(201);
    const stored = await Project.findOne().lean();
    expect(stored!.description!.length).toBeLessThanOrEqual(500);
  });

  it('refuses to commit when the plan quota is full, leaving the proposal ready', async () => {
    const max = getPlanConfig('free').maxProjects;
    const ownerId = new Types.ObjectId(alice.userId);
    for (let index = 0; index < max; index++) {
      await Project.create({
        ownerId,
        name: `Existing ${index}`,
        status: 'active',
        inputSource: { type: 'json', raw: '{}' },
        ips: { projectId: 'x', version: 1, entities: [], generationConfig: {} },
        generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 1 },
        currentVersion: 1,
      });
    }
    const doc = await seed(alice.userId);
    const res = await post(`/v1/ai/proposals/${doc._id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect((await AiProposal.findById(doc._id))!.status).toBe('ready');
    expect(await Project.countDocuments()).toBe(max);
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

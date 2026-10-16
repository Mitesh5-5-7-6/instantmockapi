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
import { AiProposal, Project } from '@instantmockapi/db';
import { fakeOutputJson } from '@instantmockapi/ai';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
  testConfig,
  type TestSession,
} from '../testing/harness.js';

let app: FastifyInstance;
let alice: TestSession;
let bob: TestSession;
let projectId: string;

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
  projectId = (await createProjectViaApi(app, alice.accessToken, 'Tours')).json().id;
  await post(`/v1/projects/${projectId}/draft`, alice.accessToken);
});

function post(url: string, token: string, payload: unknown = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: authHeader(token),
    payload: payload as Record<string, unknown>,
  });
}

const edit = (token: string, prompt = 'Add a Review entity linked to Tour') =>
  post(`/v1/projects/${projectId}/draft/ai`, token, { prompt });

/** An edit proposal the worker has finished. */
async function readyEdit() {
  const res = await edit(alice.accessToken);
  await AiProposal.updateOne(
    { _id: res.json().id },
    {
      $set: {
        status: 'ready',
        stage: null,
        result: JSON.parse(fakeOutputJson(['Customer', 'Review'])),
      },
    },
  );
  return res.json().id as string;
}

describe('POST /v1/projects/:id/draft/ai', () => {
  it('queues an edit proposal tied to the project', async () => {
    const res = await edit(alice.accessToken, '  Add a Review entity  ');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      status: 'generating',
      prompt: 'Add a Review entity',
      editsProjectId: projectId,
      projectId: null,
    });
    expect(enqueueAiProposalJob).toHaveBeenCalledWith(res.json().id, 1);
    const stored = await AiProposal.findById(res.json().id);
    expect(stored!.hints).toMatchObject({ name: 'Tours', kind: 'project' });
  });

  it('is a 404 for a project the caller does not own', async () => {
    const res = await edit(bob.accessToken);
    expect(res.statusCode).toBe(404);
    expect(await AiProposal.countDocuments()).toBe(0);
  });

  it('needs an open draft', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/draft`,
      headers: authHeader(alice.accessToken),
    });
    const res = await edit(alice.accessToken);
    expect(res.statusCode).toBe(404);
    expect(await AiProposal.countDocuments()).toBe(0);
  });

  it('rejects a blank instruction', async () => {
    const res = await edit(alice.accessToken, '   ');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('shares the hourly AI budget with new-project proposals', async () => {
    await AiProposal.create(
      Array.from({ length: 20 }, () => ({
        ownerId: alice.userId,
        prompt: 'p',
        model: 'm',
        promptVersion: 'v',
      })),
    );
    const res = await edit(alice.accessToken);
    expect(res.statusCode).toBe(429);
  });
});

describe('an edit proposal elsewhere in the AI routes', () => {
  it('can be read and cancelled like any proposal', async () => {
    const id = (await edit(alice.accessToken)).json().id;
    const read = await app.inject({
      method: 'GET',
      url: `/v1/ai/proposals/${id}`,
      headers: authHeader(alice.accessToken),
    });
    expect(read.json().editsProjectId).toBe(projectId);
    expect((await post(`/v1/ai/proposals/${id}/cancel`, alice.accessToken)).statusCode).toBe(200);
  });

  it('can never be committed as a new project', async () => {
    const id = await readyEdit();
    const projectsBefore = await Project.countDocuments();
    const res = await post(`/v1/ai/proposals/${id}/commit`, alice.accessToken);
    expect(res.statusCode).toBe(422);
    expect(await Project.countDocuments()).toBe(projectsBefore);
    expect((await AiProposal.findById(id))!.status).toBe('ready');
  });

  it('is refused by the new-project review routes', async () => {
    const id = await readyEdit();
    const draft = {
      kind: 'project',
      name: 'n',
      description: '',
      entities: JSON.parse(fakeOutputJson(['Customer'])).entities,
      generationConfig: { methods: ['GET'], mockRecords: 5 },
      authAnswered: false,
      authentication: null,
    };
    const refused = [
      post(`/v1/ai/proposals/${id}/regenerate`, alice.accessToken, { instruction: 'x' }),
      post(`/v1/ai/proposals/${id}/translate`, alice.accessToken, { language: 'fr' }),
      post(`/v1/ai/proposals/${id}/adopt`, alice.accessToken, { draft, parentRevision: 0 }),
      app.inject({
        method: 'PATCH',
        url: `/v1/ai/proposals/${id}/draft`,
        headers: authHeader(alice.accessToken),
        payload: { ...draft, revision: 0 },
      }),
    ];
    for (const res of await Promise.all(refused)) {
      // The guard's own message, so a body-schema rejection cannot pass for it.
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/edits an existing project/);
    }
  });

  it('stays out of the new-project prompt history', async () => {
    await edit(alice.accessToken);
    await AiProposal.create({
      ownerId: alice.userId,
      prompt: 'a new API',
      model: 'm',
      promptVersion: 'v',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ai/proposals',
      headers: authHeader(alice.accessToken),
    });
    expect(res.json().data.map((row: { prompt: string }) => row.prompt)).toEqual(['a new API']);
  });
});

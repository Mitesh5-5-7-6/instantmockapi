import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
    enqueueGenerationJob: vi.fn(async (...args: unknown[]) => ({ id: args[4] })),
    enqueueAiGuideJob: vi.fn(async () => ({ id: 'job' })),
  };
});

import type { FastifyInstance } from 'fastify';
import { enqueueAiGuideJob } from '@instantmockapi/queue';
import { Project, ProjectGuide } from '@instantmockapi/db';
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
  vi.mocked(enqueueAiGuideJob).mockClear();
  alice = await login(app, 'alice@example.com');
  bob = await login(app, 'bob@example.com');
  projectId = (await createProjectViaApi(app, alice.accessToken, 'Tours')).json().id;
});

const send = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const guideOf = (token = alice.accessToken, query = '') =>
  send('GET', `/v1/projects/${projectId}/guide${query}`, token);

describe('GET /v1/projects/:id/guide', () => {
  it('starts writing the guide on the first visit and returns its status', async () => {
    const res = await guideOf();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'generating', markdown: null });
    const stored = await ProjectGuide.find({ projectId });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.context).toContain('Tours');
    expect(stored[0]!.endpoints.length).toBeGreaterThan(0);
    expect(enqueueAiGuideJob).toHaveBeenCalledWith(String(stored[0]!._id), 1);
  });

  it('never calls the AI again for an unchanged definition', async () => {
    await guideOf();
    await ProjectGuide.updateOne({ projectId }, { $set: { status: 'ready', markdown: '## Hi' } });
    const res = await guideOf();
    expect(res.json()).toMatchObject({ status: 'ready', markdown: '## Hi' });
    expect(enqueueAiGuideJob).toHaveBeenCalledTimes(1);
    expect(await ProjectGuide.countDocuments({ projectId })).toBe(1);
  });

  it('writes a new guide once the definition changes', async () => {
    await guideOf();
    const project = await Project.findById(projectId);
    const ips = JSON.parse(JSON.stringify(project!.ips));
    ips.entities[0].description = 'Changed so the context differs';
    await Project.updateOne({ _id: projectId }, { $set: { ips } });
    await guideOf();
    expect(await ProjectGuide.countDocuments({ projectId })).toBe(2);
    expect(enqueueAiGuideJob).toHaveBeenCalledTimes(2);
  });

  it('settles a run that never finished as failed, so the tab stops waiting', async () => {
    await guideOf();
    await ProjectGuide.updateOne(
      { projectId },
      { $set: { requestedAt: new Date(Date.now() - 60 * 60_000) } },
    );
    expect((await guideOf()).json()).toMatchObject({ status: 'failed' });
  });

  it('is not written for an unsaved draft, which changes on every save', async () => {
    await send('POST', `/v1/projects/${projectId}/draft`, alice.accessToken);
    const res = await guideOf(alice.accessToken, '?version=draft');
    expect(res.json()).toMatchObject({ status: 'unavailable' });
    expect(enqueueAiGuideJob).not.toHaveBeenCalled();
  });

  it('is a 404 for another user', async () => {
    expect((await guideOf(bob.accessToken)).statusCode).toBe(404);
    expect(await ProjectGuide.countDocuments()).toBe(0);
  });
});

describe('POST /v1/projects/:id/guide/regenerate', () => {
  it('queues a fresh run of the stored guide', async () => {
    await guideOf();
    await ProjectGuide.updateOne(
      { projectId },
      { $set: { status: 'failed', error: { code: 'X', message: 'x' } } },
    );
    const res = await send('POST', `/v1/projects/${projectId}/guide/regenerate`, alice.accessToken);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'generating', error: null });
    const stored = await ProjectGuide.findOne({ projectId });
    expect(stored!.runs).toBe(2);
    expect(enqueueAiGuideJob).toHaveBeenLastCalledWith(String(stored!._id), 2);
  });

  it('does not start a second run while one is in progress', async () => {
    await guideOf();
    const res = await send('POST', `/v1/projects/${projectId}/guide/regenerate`, alice.accessToken);
    expect(res.statusCode).toBe(409);
    expect(enqueueAiGuideJob).toHaveBeenCalledTimes(1);
  });
});

describe('after a commit', () => {
  it('starts the guide for the new definition in the background', async () => {
    await send('POST', `/v1/projects/${projectId}/draft`, alice.accessToken);
    const project = await Project.findById(projectId);
    const ips = JSON.parse(JSON.stringify(project!.ips));
    ips.entities[0].description = 'A committed change';
    await send('PATCH', `/v1/projects/${projectId}/draft`, alice.accessToken, { ips });
    const commit = await send('POST', `/v1/projects/${projectId}/draft/commit`, alice.accessToken);
    expect(commit.statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect(await ProjectGuide.countDocuments({ projectId })).toBe(1);
    });
    const stored = await ProjectGuide.findOne({ projectId });
    expect(stored!.context).toContain('A committed change');
  });
});

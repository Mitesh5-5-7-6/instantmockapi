import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
    enqueueGenerationJob: vi.fn(async (...args: unknown[]) => ({ id: args[4] })),
  };
});

import type { FastifyInstance } from 'fastify';
import { Project } from '@instantmockapi/db';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  sampleRaw,
  startTestDb,
  stopTestDb,
  type TestSession,
} from '../testing/harness.js';

let app: FastifyInstance;
let session: TestSession;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearDb();
  session = await login(app, 'owner@example.com');
});

describe('POST /v1/projects', () => {
  it('creates a project from JSON input and returns the inferred IPS', async () => {
    const res = await createProjectViaApi(app, session.accessToken);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: 'CRM Backend', status: 'draft', currentVersion: 1 });
    expect(body.ips.projectId).toBe(body.id);
    expect(body.ips.entities.length).toBeGreaterThan(0);
    expect(body.generationConfig).toBeDefined();
  });

  it('rejects unparseable JSON input with a 422 PARSE_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeader(session.accessToken),
      payload: { name: 'Broken', inputSource: { type: 'json', raw: '{not json' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PARSE_ERROR');
  });

  it('rejects a missing name with a 400 VALIDATION_ERROR envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeader(session.accessToken),
      payload: { inputSource: { type: 'json', raw: sampleRaw } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it("rejects the unsupported 'docs' input source", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeader(session.accessToken),
      payload: { name: 'Docs', inputSource: { type: 'docs', raw: 'a spec' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('enforces the free-plan project cap with 403 PLAN_LIMIT_EXCEEDED', async () => {
    // Free plan allows 10 projects — seed 10 directly, then hit the API
    const seed = Array.from({ length: 10 }, (_, i) => ({
      ownerId: session.userId,
      name: `Seeded ${i}`,
      status: 'draft',
      inputSource: { type: 'json', raw: '{}' },
      ips: { projectId: 'x', version: 1, entities: [], generationConfig: {} },
      generationConfig: {},
    }));
    await Project.create(seed);

    const res = await createProjectViaApi(app, session.accessToken, 'One Too Many');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });
});

describe('GET /v1/projects', () => {
  it('returns the pagination envelope and only the caller’s projects', async () => {
    await createProjectViaApi(app, session.accessToken, 'Mine A');
    await createProjectViaApi(app, session.accessToken, 'Mine B');
    const stranger = await login(app, 'stranger@example.com');
    await createProjectViaApi(app, stranger.accessToken, 'Theirs');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    expect(body.data).toHaveLength(2);
    expect(body.data.map((p: { name: string }) => p.name).sort()).toEqual(['Mine A', 'Mine B']);
    // List payloads stay light — no IPS
    expect(body.data[0].ips).toBeUndefined();
  });

  it('paginates, caps limit at the configured max, and filters by search', async () => {
    for (let i = 1; i <= 3; i++) {
      await createProjectViaApi(app, session.accessToken, `Project ${i}`);
    }

    const page2 = await app.inject({
      method: 'GET',
      url: '/v1/projects?page=2&limit=2',
      headers: authHeader(session.accessToken),
    });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().meta).toEqual({ page: 2, limit: 2, total: 3 });

    const capped = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=5000',
      headers: authHeader(session.accessToken),
    });
    expect(capped.json().meta.limit).toBe(100);

    const searched = await app.inject({
      method: 'GET',
      url: '/v1/projects?q=project 2',
      headers: authHeader(session.accessToken),
    });
    expect(searched.json().data).toHaveLength(1);
    expect(searched.json().data[0].name).toBe('Project 2');
  });

  it('rejects an unknown sort field with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects?sort=-ownerId',
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('sorts by name ascending when asked', async () => {
    await createProjectViaApi(app, session.accessToken, 'Zebra');
    await createProjectViaApi(app, session.accessToken, 'Alpha');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects?sort=name',
      headers: authHeader(session.accessToken),
    });
    expect(res.json().data.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'Zebra']);
  });
});

describe('ownership (doc 13 §2)', () => {
  it('returns 404 — not 403 — when another user requests my project', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const projectId = created.json().id;
    const stranger = await login(app, 'stranger@example.com');

    for (const [method, url] of [
      ['GET', `/v1/projects/${projectId}`],
      ['PATCH', `/v1/projects/${projectId}`],
      ['DELETE', `/v1/projects/${projectId}`],
      ['POST', `/v1/projects/${projectId}/generate`],
      ['GET', `/v1/projects/${projectId}/artifacts`],
      ['GET', `/v1/projects/${projectId}/versions`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authHeader(stranger.accessToken),
        ...(method === 'PATCH' ? { payload: { name: 'Hijacked' } } : {}),
      });
      expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 404 });
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('returns 404 for malformed and unknown project ids', async () => {
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/projects/definitely-not-an-id',
      headers: authHeader(session.accessToken),
    });
    expect(malformed.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/projects/507f1f77bcf86cd799439011',
      headers: authHeader(session.accessToken),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('PATCH /v1/projects/:id', () => {
  it('renames without bumping the version', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.json().id}`,
      headers: authHeader(session.accessToken),
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed');
    expect(res.json().currentVersion).toBe(1);
  });

  it('editing the generation config bumps the version and syncs the IPS', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.json().id}`,
      headers: authHeader(session.accessToken),
      payload: {
        generationConfig: {
          validators: ['zod', 'yup'],
          types: ['typescript'],
          methods: ['GET'],
          mockRecords: 10,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentVersion).toBe(2);
    expect(body.ips.version).toBe(2);
    expect(body.generationConfig.validators).toEqual(['zod', 'yup']);
  });

  it('rejects an invalid generation config with 422 and field details', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${created.json().id}`,
      headers: authHeader(session.accessToken),
      payload: {
        generationConfig: { validators: ['mongoose'], types: [], methods: [], mockRecords: 0 },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(
      body.error.details.some((d: { path: string }) => d.path === 'generationConfig.methods'),
    ).toBe(true);
  });
});

describe('DELETE and parse', () => {
  it('hard-deletes a project', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const projectId = created.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(session.accessToken),
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: authHeader(session.accessToken),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('re-parses the stored input into a fresh IPS draft', async () => {
    const created = await createProjectViaApi(app, session.accessToken);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${created.json().id}/parse`,
      headers: authHeader(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ips.entities.length).toBeGreaterThan(0);
    expect(res.json().ips.projectId).toBe(created.json().id);
  });
});

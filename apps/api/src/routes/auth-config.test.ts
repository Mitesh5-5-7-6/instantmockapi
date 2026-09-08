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
import { Project, ProjectDraft, type IProject } from '@instantmockapi/db';
import type { AuthConfig, AuthMode, InternalProjectSchema } from '@instantmockapi/ips';
import {
  authHeader,
  buildTestServer,
  clearDb,
  createProjectViaApi,
  login,
  startTestDb,
  stopTestDb,
} from '../testing/harness.js';

/**
 * Authoring authentication through the API (Phase 3 §3, §15).
 *
 * The config lives at the IPS root, and the draft is edited by PATCHing the
 * whole `ips` — so most of this surface is inherited rather than written. These
 * tests are what establish that it actually is: that the block survives a save,
 * that the validator's rules apply through HTTP, and that a mode change stamps
 * the entities on the way through.
 */

let app: FastifyInstance;
let token: string;
let projectId: string;

beforeAll(async () => {
  await startTestDb();
  app = await buildTestServer();
}, 600_000);

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearDb();
  token = (await login(app, 'owner@example.com')).accessToken;
  projectId = (await createProjectViaApi(app, token, 'Shop')).json().id as string;
});

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: authHeader(token), ...(payload ? { payload } : {}) });
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: authHeader(token), payload });

async function reload(): Promise<IProject> {
  const project = await Project.findById(projectId);
  if (!project) {
    throw new Error('project vanished');
  }
  return project;
}

function authConfig(mode: AuthMode, over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    mode,
    signup: true,
    signin: true,
    refreshToken: true,
    cookieAuth: false,
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    userFields: [],
    ...over,
  };
}

/** Open a draft and return its IPS, ready to mutate and send back. */
async function openDraft(): Promise<InternalProjectSchema> {
  const res = await post(`/v1/projects/${projectId}/draft`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().ips as InternalProjectSchema;
}

/** PATCH the draft with an IPS, returning the response. */
const saveDraft = (ips: InternalProjectSchema) =>
  patch(`/v1/projects/${projectId}/draft`, { ips: ips as unknown as Record<string, unknown> });

async function storedDraftIps(): Promise<InternalProjectSchema> {
  const draft = await ProjectDraft.findOne({ projectId });
  if (!draft) {
    throw new Error('no draft');
  }
  return draft.ips as InternalProjectSchema;
}

describe('the auth block round trips through the draft', () => {
  it('survives a save and comes back on the draft', async () => {
    const ips = await openDraft();
    ips.authentication = authConfig('ALL_PROTECTED', { cookieAuth: true });

    const saved = await saveDraft(ips);
    expect(saved.statusCode, saved.body).toBe(200);

    const returned = (saved.json().ips as InternalProjectSchema).authentication;
    expect(returned?.mode).toBe('ALL_PROTECTED');
    expect(returned?.cookieAuth).toBe(true);
    expect((await storedDraftIps()).authentication?.mode).toBe('ALL_PROTECTED');
  });

  it('carries custom signup fields through', async () => {
    const ips = await openDraft();
    ips.authentication = authConfig('ALL_PROTECTED', {
      userFields: [{ name: 'displayName', type: 'string', required: true }],
    });

    const saved = await saveDraft(ips);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await storedDraftIps()).authentication?.userFields).toEqual([
      { name: 'displayName', type: 'string', required: true },
    ]);
  });

  it('reaches the live definition on commit', async () => {
    const ips = await openDraft();
    ips.authentication = authConfig('ALL_PROTECTED');
    expect((await saveDraft(ips)).statusCode).toBe(200);

    const digest = (
      (
        await app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/draft/impact`,
          headers: authHeader(token),
        })
      ).json() as { digest: string }
    ).digest;

    const committed = await post(`/v1/projects/${projectId}/draft/commit`, {
      acknowledgeImpact: digest,
    });
    expect(committed.statusCode, committed.body).toBe(202);

    const live = (await reload()).ips as InternalProjectSchema;
    expect(live.authentication?.mode).toBe('ALL_PROTECTED');
  });

  it('leaves a project that never mentions authentication without a block', async () => {
    // §26. Opening and saving a draft must not conjure a configuration.
    const ips = await openDraft();
    expect((await saveDraft(ips)).statusCode).toBe(200);
    expect((await storedDraftIps()).authentication).toBeUndefined();
  });
});

describe('the validator applies through HTTP', () => {
  const save = async (authentication: unknown) => {
    const ips = await openDraft();
    (ips as unknown as Record<string, unknown>)['authentication'] = authentication;
    return saveDraft(ips);
  };

  it('rejects an unrecognised mode', async () => {
    const res = await save({ mode: 'ALL_THE_THINGS' });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a malformed token lifetime', async () => {
    const res = await save({ mode: 'ALL_PROTECTED', accessTokenExpiresIn: '900' });
    expect(res.statusCode).toBe(422);
  });

  /**
   * The reserved-name check, which only bites once authentication is on — §26's
   * projects with a `Me` entity keep working until they ask for an Auth API.
   */
  it('rejects an entity that collides with an auth endpoint', async () => {
    const ips = await openDraft();
    ips.entities[0]!.name = 'Me';
    // Renaming alone is fine.
    expect((await saveDraft(ips)).statusCode, 'rename without auth').toBe(200);

    const withAuth = await storedDraftIps();
    withAuth.authentication = authConfig('ALL_PROTECTED');
    const res = await saveDraft(withAuth);
    expect(res.statusCode).toBe(422);
    const issues = (res.json().error.details as { issue: string }[]).map((d) => d.issue);
    expect(issues.join(' ')).toContain('Auth API endpoint');
  });

  it('rejects a custom field that shadows a reserved one', async () => {
    const res = await save({
      mode: 'ALL_PROTECTED',
      userFields: [{ name: 'passwordHash', type: 'string', required: false }],
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('§3: a mode change stamps the entities', () => {
  /**
   * The surprise this prevents: with no stamping, every entity is unstamped in
   * COMBINATION mode and `entityAuth`'s fail-closed fallback takes the whole
   * API dark in one click — a breaking change the user never asked for.
   */
  it('preserves public entities when entering COMBINATION from ALL_PUBLIC', async () => {
    const first = await openDraft();
    first.authentication = authConfig('ALL_PUBLIC');
    expect((await saveDraft(first)).statusCode).toBe(200);

    const second = await storedDraftIps();
    second.authentication = authConfig('COMBINATION');
    expect((await saveDraft(second)).statusCode).toBe(200);

    const stamped = await storedDraftIps();
    expect(stamped.entities.every((entity) => entity.authentication === 'PUBLIC')).toBe(true);
  });

  it('preserves protected entities when entering COMBINATION from ALL_PROTECTED', async () => {
    const first = await openDraft();
    first.authentication = authConfig('ALL_PROTECTED');
    expect((await saveDraft(first)).statusCode).toBe(200);

    const second = await storedDraftIps();
    second.authentication = authConfig('COMBINATION');
    expect((await saveDraft(second)).statusCode).toBe(200);

    expect(
      (await storedDraftIps()).entities.every((entity) => entity.authentication === 'PROTECTED'),
    ).toBe(true);
  });

  it('starts open when turning authentication on from nothing', async () => {
    // Mode NONE means everything was public, so combination mode begins public.
    // Turning authentication on must not also protect everything.
    const ips = await openDraft();
    ips.authentication = authConfig('COMBINATION');
    expect((await saveDraft(ips)).statusCode).toBe(200);
    expect(
      (await storedDraftIps()).entities.every((entity) => entity.authentication === 'PUBLIC'),
    ).toBe(true);
  });

  it('clears the stamps on the way out of COMBINATION', async () => {
    const first = await openDraft();
    first.authentication = authConfig('COMBINATION');
    expect((await saveDraft(first)).statusCode).toBe(200);

    const second = await storedDraftIps();
    second.authentication = authConfig('ALL_PROTECTED');
    expect((await saveDraft(second)).statusCode).toBe(200);

    // A stale stamp is ignored by `entityAuth` but contradicts the mode in
    // force, so it must not be left behind.
    expect(
      (await storedDraftIps()).entities.every((entity) => entity.authentication === undefined),
    ).toBe(true);
  });

  /**
   * The bug the two-document signature exists to prevent: taking the whole auth
   * block from the outgoing config would silently revert a cookie change made
   * in the same edit.
   */
  it('keeps other settings changed in the same edit', async () => {
    const first = await openDraft();
    first.authentication = authConfig('ALL_PUBLIC');
    expect((await saveDraft(first)).statusCode).toBe(200);

    const second = await storedDraftIps();
    second.authentication = authConfig('COMBINATION', {
      cookieAuth: true,
      accessTokenExpiresIn: '5m',
    });
    expect((await saveDraft(second)).statusCode).toBe(200);

    const stored = await storedDraftIps();
    expect(stored.authentication?.mode).toBe('COMBINATION');
    expect(stored.authentication?.cookieAuth).toBe(true);
    expect(stored.authentication?.accessTokenExpiresIn).toBe('5m');
  });

  it('leaves an explicit per-entity choice alone when the mode holds still', async () => {
    const first = await openDraft();
    first.authentication = authConfig('COMBINATION');
    expect((await saveDraft(first)).statusCode).toBe(200);

    // Now the user flips one entity by hand. The mode is unchanged, so nothing
    // may re-stamp over their choice.
    const second = await storedDraftIps();
    second.entities[0]!.authentication = 'PROTECTED';
    expect((await saveDraft(second)).statusCode).toBe(200);

    expect((await storedDraftIps()).entities[0]!.authentication).toBe('PROTECTED');
  });
});

describe('the diff sees an auth change', () => {
  it('reports a mode change in the draft impact', async () => {
    const ips = await openDraft();
    ips.authentication = authConfig('ALL_PROTECTED');
    expect((await saveDraft(ips)).statusCode).toBe(200);

    const impact = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/draft/impact`,
      headers: authHeader(token),
    });
    expect(impact.statusCode, impact.body).toBe(200);

    const body = impact.json();
    const kinds = (body.changes as { kind: string }[]).map((change) => change.kind);
    expect(kinds).toContain('AUTH_MODE_CHANGED');
    // Every endpoint closes, so the report must say so rather than claiming
    // nothing is affected.
    expect(body.affected.length).toBeGreaterThan(0);
    expect(body.risk).toBe('BREAKING');
  });

  it('regenerates the surface artifacts and not the validators', async () => {
    const ips = await openDraft();
    ips.authentication = authConfig('ALL_PROTECTED');
    expect((await saveDraft(ips)).statusCode).toBe(200);

    const impact = (
      await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/draft/impact`,
        headers: authHeader(token),
      })
    ).json();

    expect(impact.artifacts).toContain('hosted_api');
    expect(impact.artifacts).toContain('openapi');
    expect(impact.artifacts).not.toContain('zod');
    expect(impact.artifacts).not.toContain('mock_data');
  });
});

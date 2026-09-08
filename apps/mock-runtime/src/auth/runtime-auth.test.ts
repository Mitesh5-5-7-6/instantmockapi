import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import {
  Artifact,
  MockSession,
  MockStore,
  MockUser,
  MockAuthSecret,
  Project,
  User,
  connectDB,
  disconnectDB,
} from '@instantmockapi/db';
import { artifactKey, createMemoryStorage, type MemoryStorage } from '@instantmockapi/storage';
import { generateHostingConfig } from '@instantmockapi/generator-hosting';
import type { AuthConfig, AuthMode, InternalProjectSchema } from '@instantmockapi/ips';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { createMemoryCache } from '../cache.js';
import { buildMockRuntime } from '../server.js';

/**
 * The generated Auth API, end to end (Phase 3 §28).
 *
 * The unit tests in `tokens.test.ts` prove the signer is isolated. These prove
 * the *product* works: that a signup produces a token, that the token opens a
 * protected entity, that it opens **only** that project's protected entity, and
 * that logging out closes it again.
 *
 * §28 names the two that matter most, and both are here:
 *
 *   signUp → signIn → accessToken → GET /me → protected entity → refresh
 *          → logout → protected request fails
 *
 *   Project A token → Project B API   must fail
 */

let mongod: MongoMemoryServer;
let app: FastifyInstance;
const storage: MemoryStorage = createMemoryStorage();
const cache = createMemoryCache();
const baseConfig: EnvConfig = loadEnvConfig();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
  app = await buildMockRuntime({ config: baseConfig, storage, cache, rateLimit: false });
}, 600_000);

afterAll(async () => {
  await app.close();
  await disconnectDB();
  await mongod.stop();
});

beforeEach(async () => {
  storage.clear();
  cache.clear();
  await Promise.all(
    [User, Project, Artifact, MockStore, MockUser, MockSession, MockAuthSecret].map((model) =>
      model.deleteMany({}),
    ),
  );
});

const PASSWORD = 'correct-horse-battery';

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

/**
 * Two entities, so "only the protected one is closed" is checkable.
 *
 * `Product` public and `Order` protected under COMBINATION — §2C's own example
 * shape, and the pair that makes an over-broad gate visible.
 */
function makeIps(
  projectId: string,
  auth: AuthConfig | null,
  stamps: Record<string, 'PUBLIC' | 'PROTECTED'> = {},
): InternalProjectSchema {
  const entity = (name: string) => ({
    id: `ent_${name.toLowerCase()}`,
    name,
    fields: [
      {
        id: `ent_${name.toLowerCase()}_id`,
        name: 'id',
        type: 'uuid' as const,
        required: false,
        default: null,
        children: [],
      },
      {
        id: `ent_${name.toLowerCase()}_label`,
        name: 'label',
        type: 'string' as const,
        required: false,
        default: null,
        children: [],
      },
    ],
    ...(stamps[name] === undefined ? {} : { authentication: stamps[name] }),
  });

  return {
    projectId,
    version: 1,
    entities: [entity('Product'), entity('Order')],
    generationConfig: {
      validators: [],
      types: [],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 2,
    },
    ...(auth === null ? {} : { authentication: auth }),
  } as unknown as InternalProjectSchema;
}

/** Stage a hosted project whose config carries the given authentication. */
async function stageProject(
  auth: AuthConfig | null,
  stamps: Record<string, 'PUBLIC' | 'PROTECTED'> = {},
): Promise<string> {
  const owner = await User.create({
    email: `owner-${Math.random().toString(36).slice(2)}@x.dev`,
    authProvider: 'email',
  });
  const project = new Project({
    ownerId: owner._id,
    name: 'Auth Test',
    status: 'active',
    inputSource: { type: 'json', raw: '{}' },
    currentVersion: 1,
    hosted: {
      url: 'https://api.instantmockapi.dev/p/x',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const ips = makeIps(String(project._id), auth, stamps);
  project.ips = ips;
  project.generationConfig = ips.generationConfig;
  await project.save();
  const projectId = String(project._id);

  const files = generateHostingConfig(ips);
  const ref = artifactKey(projectId, 1, 'hosted_api', 'hosting.config.json');
  await storage.put(ref, files['hosting.config.json'] ?? '{}', 'application/json');
  await Artifact.create({
    projectId: project._id,
    artifactType: 'hosted_api',
    version: 1,
    status: 'completed',
    storageRef: ref,
    generatedAt: new Date(),
    workerId: 'F',
  });

  for (const entity of ['product', 'order']) {
    await MockStore.create({
      projectId: project._id,
      entity,
      records: [{ id: `${entity}-1`, label: 'One' }],
    });
  }
  return projectId;
}

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Sign up and return the credentials the response handed out. */
async function signUpUser(
  projectId: string,
  email = 'end-user@example.com',
  extra: Record<string, unknown> = {},
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await post(`/p/${projectId}/signUp`, { email, password: PASSWORD, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return {
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
    userId: body.user.id as string,
  };
}

describe('§28: the complete flow', () => {
  it('signs up, signs in, reads /me, opens a protected entity, refreshes, logs out', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));

    // signUp
    const signedUp = await signUpUser(projectId);
    expect(signedUp.accessToken).toBeTruthy();
    expect(signedUp.refreshToken).toBeTruthy();

    // signIn — the credentials work a second time, independently.
    const signIn = await post(`/p/${projectId}/signIn`, {
      email: 'end-user@example.com',
      password: PASSWORD,
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const access = signIn.json().accessToken as string;
    const refreshToken = signIn.json().refreshToken as string;

    // GET /me
    const me = await get(`/p/${projectId}/me`, bearer(access));
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user.email).toBe('end-user@example.com');

    // A protected entity, with and without the token.
    expect((await get(`/p/${projectId}/order`)).statusCode).toBe(401);
    expect((await get(`/p/${projectId}/order`, bearer(access))).statusCode).toBe(200);

    // refresh
    const refreshed = await post(`/p/${projectId}/refresh`, { refreshToken });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const rotated = refreshed.json().accessToken as string;
    expect((await get(`/p/${projectId}/order`, bearer(rotated))).statusCode).toBe(200);

    // logout, then the refresh token is dead
    const loggedOut = await post(`/p/${projectId}/logout`, {
      refreshToken: refreshed.json().refreshToken,
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(
      (
        await post(`/p/${projectId}/refresh`, {
          refreshToken: refreshed.json().refreshToken,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('§28: project isolation', () => {
  /**
   * The test §28 names explicitly, and the one the per-project key exists for.
   * The same email signs up to both projects, so nothing but the key and the
   * audience distinguishes the tokens.
   */
  it('refuses a Project A token against Project B', async () => {
    const projectA = await stageProject(authConfig('ALL_PROTECTED'));
    const projectB = await stageProject(authConfig('ALL_PROTECTED'));

    const a = await signUpUser(projectA, 'shared@example.com');
    await signUpUser(projectB, 'shared@example.com');

    expect((await get(`/p/${projectA}/order`, bearer(a.accessToken))).statusCode).toBe(200);
    expect((await get(`/p/${projectB}/order`, bearer(a.accessToken))).statusCode).toBe(401);
    expect((await get(`/p/${projectB}/me`, bearer(a.accessToken))).statusCode).toBe(401);
  });

  it('gives each project its own signing key', async () => {
    const projectA = await stageProject(authConfig('ALL_PROTECTED'));
    const projectB = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectA);
    await signUpUser(projectB);

    const secrets = await MockAuthSecret.find({});
    expect(secrets).toHaveLength(2);
    expect(secrets[0]!.secret).not.toBe(secrets[1]!.secret);
  });

  it('lets the same address hold separate accounts per project', async () => {
    // The unique index is `(projectId, email)`, so this is the data-layer half
    // of the same isolation story.
    const projectA = await stageProject(authConfig('ALL_PROTECTED'));
    const projectB = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectA, 'shared@example.com');
    await signUpUser(projectB, 'shared@example.com');
    expect(await MockUser.countDocuments({ email: 'shared@example.com' })).toBe(2);
  });

  it('will not let a refresh token cross projects either', async () => {
    const projectA = await stageProject(authConfig('ALL_PROTECTED'));
    const projectB = await stageProject(authConfig('ALL_PROTECTED'));
    const a = await signUpUser(projectA);
    await signUpUser(projectB);

    // The session row is keyed on projectId, so B's lookup cannot find it —
    // which matters because a refresh token is opaque and carries no audience.
    const res = await post(`/p/${projectB}/refresh`, { refreshToken: a.refreshToken });
    expect(res.statusCode).toBe(401);
  });
});

describe('§12/§13: public and protected', () => {
  it('serves a public entity with no token at all', async () => {
    const projectId = await stageProject(authConfig('COMBINATION'), {
      Product: 'PUBLIC',
      Order: 'PROTECTED',
    });
    expect((await get(`/p/${projectId}/product`)).statusCode).toBe(200);
  });

  it('closes only the protected entity', async () => {
    const projectId = await stageProject(authConfig('COMBINATION'), {
      Product: 'PUBLIC',
      Order: 'PROTECTED',
    });
    expect((await get(`/p/${projectId}/product`)).statusCode).toBe(200);
    expect((await get(`/p/${projectId}/order`)).statusCode).toBe(401);
  });

  it('closes every entity under ALL_PROTECTED', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    expect((await get(`/p/${projectId}/product`)).statusCode).toBe(401);
    expect((await get(`/p/${projectId}/order`)).statusCode).toBe(401);
  });

  it('opens every entity under ALL_PUBLIC while still serving the Auth API', async () => {
    const projectId = await stageProject(authConfig('ALL_PUBLIC'));
    expect((await get(`/p/${projectId}/order`)).statusCode).toBe(200);
    // §2A: authentication exists, nothing is protected by it.
    expect(
      (await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD })).statusCode,
    ).toBe(201);
  });

  /**
   * Every method, not just the readable ones.
   *
   * The gate uses `aspect: 'routing'`-style reasoning: protection covers the
   * whole endpoint. A gate wired to the read/write path would have let DELETE
   * through, which is the one method where getting it wrong is unrecoverable.
   */
  it('protects every method including DELETE', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/p/${projectId}/order/order-1`,
        ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
          ? { payload: { label: 'x' } }
          : {}),
      });
      expect(res.statusCode, `${method} should be 401`).toBe(401);
    }
  });

  /**
   * The gate runs **before** the handler, which is the whole reason it sits
   * where it does. A DELETE that removed the record and then answered 401 would
   * be an honest response about data that was already gone.
   */
  it('does not delete the record before refusing', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const before = await MockStore.findOne({ entity: 'order' });
    expect(before?.records).toHaveLength(1);

    expect(
      (await app.inject({ method: 'DELETE', url: `/p/${projectId}/order/order-1` })).statusCode,
    ).toBe(401);

    const after = await MockStore.findOne({ entity: 'order' });
    expect(after?.records).toHaveLength(1);
  });
});

describe('§26: a project written before Phase 3', () => {
  it('serves its entities exactly as before', async () => {
    const projectId = await stageProject(null);
    expect((await get(`/p/${projectId}/product`)).statusCode).toBe(200);
    expect((await get(`/p/${projectId}/order`)).statusCode).toBe(200);
  });

  /**
   * `/signUp` must 404, not 401 or 500. The route was never generated, and the
   * honest answer for a route that does not exist is that it does not exist.
   */
  it('404s every auth endpoint', async () => {
    const projectId = await stageProject(null);
    expect(
      (await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD })).statusCode,
    ).toBe(404);
    expect((await get(`/p/${projectId}/me`)).statusCode).toBe(404);
    expect((await post(`/p/${projectId}/logout`)).statusCode).toBe(404);
  });

  it('mints no signing key for a project that never asked for one', async () => {
    const projectId = await stageProject(null);
    await get(`/p/${projectId}/product`);
    expect(await MockAuthSecret.countDocuments({})).toBe(0);
  });
});

describe('§5/§6: signUp and signIn', () => {
  it('refuses a duplicate address with 409 rather than a silent success', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectId, 'taken@example.com');
    const res = await post(`/p/${projectId}/signUp`, {
      email: 'taken@example.com',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(409);
  });

  it('treats the address case-insensitively', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectId, 'Mixed@Example.com');
    const res = await post(`/p/${projectId}/signIn`, {
      email: 'mixed@example.COM',
      password: PASSWORD,
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * §6: one message for both. Distinguishing them turns signIn into an
   * account-existence oracle.
   */
  it('answers identically for a wrong password and an unknown address', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectId, 'known@example.com');

    const wrongPassword = await post(`/p/${projectId}/signIn`, {
      email: 'known@example.com',
      password: 'not-the-password',
    });
    const unknownEmail = await post(`/p/${projectId}/signIn`, {
      email: 'nobody@example.com',
      password: PASSWORD,
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('validates the payload with field detail', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const res = await post(`/p/${projectId}/signUp`, { email: 'not-an-email', password: 'short' });
    // 422, per the shared error map: VALIDATION_ERROR carries field detail.
    expect(res.statusCode).toBe(422);
    const paths = (res.json().error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toContain('email');
    expect(paths).toContain('password');
  });

  it('stores the project’s declared custom fields and rejects a missing required one', async () => {
    const projectId = await stageProject(
      authConfig('ALL_PROTECTED', {
        userFields: [
          { name: 'name', type: 'string', required: true },
          { name: 'age', type: 'number', required: false },
        ],
      }),
    );

    const missing = await post(`/p/${projectId}/signUp`, {
      email: 'a@b.co',
      password: PASSWORD,
    });
    expect(missing.statusCode).toBe(422);

    const ok = await post(`/p/${projectId}/signUp`, {
      email: 'a@b.co',
      password: PASSWORD,
      name: 'Ada',
      age: 36,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().user.name).toBe('Ada');
    expect(ok.json().user.age).toBe(36);
  });

  /**
   * §23: a caller must not be able to write a key the project never declared.
   * An undeclared field is dropped rather than rejected — it is not an error to
   * send extra JSON — but it must not reach the document.
   */
  it('ignores an undeclared field rather than storing it', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const res = await post(`/p/${projectId}/signUp`, {
      email: 'a@b.co',
      password: PASSWORD,
      passwordHash: 'injected',
      isAdmin: true,
    });
    expect(res.statusCode).toBe(201);

    const stored = await MockUser.findOne({ email: 'a@b.co' });
    expect(stored?.fields).toEqual({});
    expect(res.json().user.isAdmin).toBeUndefined();
  });
});

describe('§10/§23: what never leaves', () => {
  it('never returns a password hash from any endpoint', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { accessToken, refreshToken } = await signUpUser(projectId);

    const bodies = [
      (await post(`/p/${projectId}/signIn`, { email: 'end-user@example.com', password: PASSWORD }))
        .body,
      (await get(`/p/${projectId}/me`, bearer(accessToken))).body,
      (await post(`/p/${projectId}/refresh`, { refreshToken })).body,
    ];

    for (const body of bodies) {
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('$scrypt');
      expect(body).not.toContain(PASSWORD);
    }
  });

  it('never returns the stored session row', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);
    const session = await MockSession.findOne({});
    expect(session?.tokenHash).toBeTruthy();

    const res = await post(`/p/${projectId}/refresh`, { refreshToken });
    expect(res.body).not.toContain(session!.tokenHash);
  });
});

describe('§8: refresh rotation and revocation', () => {
  /**
   * The assertion order here is load-bearing, and getting it wrong is how this
   * test first failed.
   *
   * Replaying the spent token triggers the chain-kill below, which revokes the
   * *new* token too — by design. So "the successor works" has to be checked
   * before "the predecessor is refused", or the test destroys the state it is
   * about to assert on. Reordering it to read more naturally would make it fail,
   * and the tempting fix would be to weaken the replay detection.
   */
  it('rotates the token, and the successor works', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);

    const first = await post(`/p/${projectId}/refresh`, { refreshToken });
    expect(first.statusCode).toBe(200);
    const next = first.json().refreshToken as string;
    expect(next).not.toBe(refreshToken);

    // The successor is live...
    expect((await post(`/p/${projectId}/refresh`, { refreshToken: next })).statusCode).toBe(200);
  });

  it('refuses the predecessor once it has been exchanged', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);

    await post(`/p/${projectId}/refresh`, { refreshToken });
    expect((await post(`/p/${projectId}/refresh`, { refreshToken })).statusCode).toBe(401);
  });

  /**
   * Replay detection: a revoked token being presented again means it exists in
   * two places. Neither holder can be trusted, so the whole chain dies and a
   * fresh signin is required.
   */
  it('kills the whole chain when a spent token is replayed', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);

    const rotated = (await post(`/p/${projectId}/refresh`, { refreshToken })).json()
      .refreshToken as string;

    // The attacker replays the spent token...
    expect((await post(`/p/${projectId}/refresh`, { refreshToken })).statusCode).toBe(401);
    // ...which also invalidates the legitimate client's current token.
    expect((await post(`/p/${projectId}/refresh`, { refreshToken: rotated })).statusCode).toBe(401);
  });

  it('refuses a refresh token that was never issued', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    await signUpUser(projectId);
    expect((await post(`/p/${projectId}/refresh`, { refreshToken: 'made-up' })).statusCode).toBe(
      401,
    );
  });

  /**
   * The access token is a JWT and the refresh token is opaque, so presenting
   * one where the other belongs must fail — the classic confusion the `type`
   * claim exists to stop, checked through the HTTP surface this time.
   */
  it('refuses an access token presented as a refresh token', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { accessToken } = await signUpUser(projectId);
    expect((await post(`/p/${projectId}/refresh`, { refreshToken: accessToken })).statusCode).toBe(
      401,
    );
  });

  it('refuses a refresh token presented as an access token', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);
    expect((await get(`/p/${projectId}/order`, bearer(refreshToken))).statusCode).toBe(401);
  });
});

describe('§11: logout', () => {
  it('succeeds even when the access token has already lapsed', async () => {
    // The caller who most needs logout is the one whose access token is gone
    // but who still holds a refresh token. Requiring authentication first would
    // lock them out of logging out.
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);
    expect((await post(`/p/${projectId}/logout`, { refreshToken })).statusCode).toBe(204);
  });

  it('is a no-op rather than an error with no credential', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    expect((await post(`/p/${projectId}/logout`)).statusCode).toBe(204);
  });

  it('leaves the account intact — logout is not deletion', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { refreshToken } = await signUpUser(projectId);
    await post(`/p/${projectId}/logout`, { refreshToken });

    const res = await post(`/p/${projectId}/signIn`, {
      email: 'end-user@example.com',
      password: PASSWORD,
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('§9: cookie authentication', () => {
  const cookieProject = () => stageProject(authConfig('ALL_PROTECTED', { cookieAuth: true }));

  /** The point of cookie mode: the token never reaches JavaScript. */
  it('sets HttpOnly cookies and keeps the tokens out of the body', async () => {
    const projectId = await cookieProject();
    const res = await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD });
    expect(res.statusCode, res.body).toBe(201);

    expect(res.json().accessToken).toBeUndefined();
    expect(res.json().refreshToken).toBeUndefined();
    expect(res.json().user.email).toBe('a@b.co');

    const cookies = res.headers['set-cookie'];
    const serialised = Array.isArray(cookies) ? cookies.join('\n') : String(cookies);
    expect(serialised).toContain('ima_access=');
    expect(serialised).toContain('HttpOnly');
    expect(serialised).toContain('SameSite=Lax');
  });

  it('authenticates a protected entity from the cookie alone', async () => {
    const projectId = await cookieProject();
    const signUp = await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD });
    const raw = signUp.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)])
      .map((entry) => entry.split(';')[0])
      .join('; ');

    const res = await get(`/p/${projectId}/order`, { cookie });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refreshes from the cookie, with no body at all', async () => {
    const projectId = await cookieProject();
    const signUp = await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD });
    const raw = signUp.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)])
      .map((entry) => entry.split(';')[0])
      .join('; ');

    const res = await post(`/p/${projectId}/refresh`, undefined, { cookie });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('clears the cookies on logout', async () => {
    const projectId = await cookieProject();
    const signUp = await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD });
    const raw = signUp.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)])
      .map((entry) => entry.split(';')[0])
      .join('; ');

    const res = await post(`/p/${projectId}/logout`, undefined, { cookie });
    expect(res.statusCode).toBe(204);
    const cleared = res.headers['set-cookie'];
    expect(Array.isArray(cleared) ? cleared.join('\n') : String(cleared)).toContain('Max-Age=0');
  });

  /**
   * An explicit header must beat a stale cookie, or a developer testing with
   * `curl -H Authorization` against a cookie-mode project would silently be
   * whoever the cookie belongs to.
   */
  it('prefers an explicit Authorization header over the cookie', async () => {
    const projectId = await cookieProject();
    const first = await post(`/p/${projectId}/signUp`, { email: 'one@b.co', password: PASSWORD });
    const raw = first.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)])
      .map((entry) => entry.split(';')[0])
      .join('; ');

    // A garbage header with a valid cookie present must still 401 — proving the
    // header was consulted rather than skipped in favour of the cookie.
    const res = await get(`/p/${projectId}/me`, { cookie, authorization: 'Bearer nonsense' });
    expect(res.statusCode).toBe(401);
  });
});

describe('§4: which endpoints exist', () => {
  it('404s signUp when the project turned it off', async () => {
    // An invite-only API: accounts exist, but not through a public endpoint.
    const projectId = await stageProject(authConfig('ALL_PROTECTED', { signup: false }));
    expect(
      (await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD })).statusCode,
    ).toBe(404);
    expect(
      (await post(`/p/${projectId}/signIn`, { email: 'a@b.co', password: PASSWORD })).statusCode,
    ).toBe(401);
  });

  it('404s refresh when refresh tokens are off, and issues none', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED', { refreshToken: false }));
    const res = await post(`/p/${projectId}/signUp`, { email: 'a@b.co', password: PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.json().refreshToken).toBeUndefined();
    expect((await post(`/p/${projectId}/refresh`, { refreshToken: 'x' })).statusCode).toBe(404);
  });

  it('405s the wrong method on an auth endpoint', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    expect((await get(`/p/${projectId}/signUp`)).statusCode).toBe(405);
    expect((await post(`/p/${projectId}/me`)).statusCode).toBe(405);
  });

  it('accepts both /signUp and /signup', async () => {
    // `entitySlug` lowercases while §4 writes camelCase, so both spellings must
    // reach the same handler — otherwise one of them is an entity lookup.
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    expect(
      (await post(`/p/${projectId}/signup`, { email: 'a@b.co', password: PASSWORD })).statusCode,
    ).toBe(201);
    expect(
      (await post(`/p/${projectId}/signUp`, { email: 'c@d.co', password: PASSWORD })).statusCode,
    ).toBe(201);
  });
});

describe('the protection gate sits in the right place', () => {
  /**
   * 405 outranks 401.
   *
   * Otherwise the auth requirement masks which methods exist, and a developer
   * debugging their own project cannot tell "you need a token" from "this
   * method is switched off".
   */
  it('answers 405 for a disabled method before asking for a token', async () => {
    const owner = await User.create({ email: `o-${Math.random()}@x.dev`, authProvider: 'email' });
    const project = new Project({
      ownerId: owner._id,
      name: 'Read Only',
      status: 'active',
      inputSource: { type: 'json', raw: '{}' },
      currentVersion: 1,
      hosted: { url: 'https://x/p/y', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const ips = makeIps(String(project._id), authConfig('ALL_PROTECTED'));
    // GET only, so DELETE is not an enabled method for any entity.
    ips.generationConfig.methods = ['GET'];
    project.ips = ips;
    project.generationConfig = ips.generationConfig;
    await project.save();

    const files = generateHostingConfig(ips);
    const ref = artifactKey(String(project._id), 1, 'hosted_api', 'hosting.config.json');
    await storage.put(ref, files['hosting.config.json'] ?? '{}', 'application/json');
    await Artifact.create({
      projectId: project._id,
      artifactType: 'hosted_api',
      version: 1,
      status: 'completed',
      storageRef: ref,
      generatedAt: new Date(),
      workerId: 'F',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/p/${String(project._id)}/order/order-1`,
    });
    expect(res.statusCode).toBe(405);
  });

  it('still 404s an unknown entity rather than demanding a token first', async () => {
    // A typo should say "no such entity", not "sign in and try again".
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    expect((await get(`/p/${projectId}/nosuchthing`)).statusCode).toBe(404);
  });
});

describe('§14: the middleware validates more than the signature', () => {
  it('refuses a token for a user who no longer exists', async () => {
    // A token outlives a deleted account, so `sub` is a lookup key rather than
    // an identity — §23's "do not trust client-provided user IDs".
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { accessToken, userId } = await signUpUser(projectId);
    expect((await get(`/p/${projectId}/order`, bearer(accessToken))).statusCode).toBe(200);

    await MockUser.deleteOne({ _id: userId });
    expect((await get(`/p/${projectId}/order`, bearer(accessToken))).statusCode).toBe(401);
  });

  it('refuses a missing, malformed or empty credential the same way', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    for (const headers of [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: 'Basic abc' },
      { authorization: 'Bearer a.b.c' },
    ]) {
      const res = await get(`/p/${projectId}/order`, headers as Record<string, string>);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  /**
   * §23 forbids tokens in URLs, so a query parameter must not authenticate —
   * a token in a URL ends up in access logs, browser history and referrers.
   */
  it('does not accept a token from the query string', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    const { accessToken } = await signUpUser(projectId);
    const res = await get(`/p/${projectId}/order?access_token=${accessToken}`);
    expect(res.statusCode).toBe(401);
  });
});

describe('§23: the credential throttle, live', () => {
  /**
   * A second runtime, with rate limiting ON and a tiny credential budget.
   *
   * The shared `app` above disables rate limiting entirely — every other test
   * would otherwise be one signIn away from a 429 and would fail in an order
   * dependent way.
   */
  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await buildMockRuntime({
      config: baseConfig,
      storage,
      cache,
      // A generous project budget and a tiny credential one, so a 429 on
      // signIn can only have come from the credential bucket.
      rateLimit: { max: 500, authMax: 3, timeWindowMs: 60_000 },
    });
  }, 600_000);

  afterAll(async () => {
    await limited.close();
  });

  const attempt = (projectId: string, endpoint = 'signIn') =>
    limited.inject({
      method: 'POST',
      url: `/p/${projectId}/${endpoint}`,
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });

  it('throttles credential attempts well before the project budget', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));

    // Three are allowed (401 — wrong credentials, but not throttled).
    for (let i = 0; i < 3; i += 1) {
      expect((await attempt(projectId)).statusCode, `attempt ${i}`).toBe(401);
    }
    // The fourth is refused by the limiter, far short of the 500 project budget.
    expect((await attempt(projectId)).statusCode).toBe(429);
  });

  /**
   * One shared bucket. Rotating endpoints must not buy more attempts, which is
   * exactly what a bucket-per-endpoint would allow.
   */
  it('counts signUp, signIn and refresh against one budget', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));

    expect((await attempt(projectId, 'signUp')).statusCode).not.toBe(429);
    expect((await attempt(projectId, 'signIn')).statusCode).not.toBe(429);
    expect((await attempt(projectId, 'refresh')).statusCode).not.toBe(429);
    // Fourth attempt across the three endpoints, same bucket.
    expect((await attempt(projectId, 'signIn')).statusCode).toBe(429);
  });

  /**
   * The two buckets advertise different ceilings, which is the most direct
   * evidence that `max` and `keyGenerator` agree about which bucket a request
   * belongs to. If either got it wrong, both responses would report the same
   * limit.
   */
  it('advertises the tight ceiling on credentials and the wide one on entities', async () => {
    const projectId = await stageProject(authConfig('ALL_PUBLIC'));

    const credential = await attempt(projectId);
    const entity = await limited.inject({ method: 'GET', url: `/p/${projectId}/product` });

    expect(credential.headers['x-ratelimit-limit']).toBe('3');
    expect(entity.headers['x-ratelimit-limit']).toBe('500');
  });

  /**
   * The reason the credential bucket is separate at all: brute-forcing one
   * account must not deny service to the API's ordinary callers.
   *
   * Its own runtime, with a project budget **smaller than the number of
   * attempts made**. That is what makes the test discriminating: on the shared
   * instance above, six attempts against a 500 budget would leave entity
   * traffic serving whether or not the buckets were separate, so the test would
   * pass while proving nothing.
   */
  it('leaves entity traffic serving after the credential budget is spent', async () => {
    const projectId = await stageProject(authConfig('COMBINATION'), {
      Product: 'PUBLIC',
      Order: 'PROTECTED',
    });

    const tight = await buildMockRuntime({
      config: baseConfig,
      storage,
      cache,
      rateLimit: { max: 4, authMax: 2, timeWindowMs: 60_000 },
    });

    try {
      // Five attempts against a project budget of four: enough to exhaust a
      // shared counter, so a 200 below can only mean the buckets are separate.
      for (let i = 0; i < 5; i += 1) {
        await tight.inject({
          method: 'POST',
          url: `/p/${projectId}/signIn`,
          payload: { email: 'nobody@example.com', password: PASSWORD },
        });
      }

      const res = await tight.inject({ method: 'GET', url: `/p/${projectId}/product` });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await tight.close();
    }
  });

  it('does not throttle /me or /logout on the credential budget', async () => {
    const projectId = await stageProject(authConfig('ALL_PROTECTED'));
    for (let i = 0; i < 5; i += 1) {
      await attempt(projectId);
    }

    // Spent credential budget, but a session check is not a guess.
    expect((await limited.inject({ method: 'GET', url: `/p/${projectId}/me` })).statusCode).toBe(
      401,
    );
    expect(
      (await limited.inject({ method: 'POST', url: `/p/${projectId}/logout` })).statusCode,
    ).toBe(204);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
  };
});

import type { FastifyInstance } from 'fastify';
import { AuthToken, User } from '@instantmockapi/db';
import {
  REFRESH_COOKIE,
  authHeader,
  buildTestServer,
  clearDb,
  createCapturingMailer,
  createFailingMailer,
  csrfHeader,
  startTestDb,
  stopTestDb,
  type CapturingMailer,
} from '../testing/harness.js';
import { MIN_PASSWORD_LENGTH, passwordProblems } from '../auth-service.js';

let app: FastifyInstance;
let mailer: CapturingMailer;

/** Long enough for a few real scrypt hashes at 64MB each. */
const SLOW = 30_000;

const PASSWORD = 'correct-horse-battery';
const OTHER_PASSWORD = 'a-different-long-one';

beforeAll(async () => {
  await startTestDb();
  mailer = createCapturingMailer();
  app = await buildTestServer({ mailer });
}, 600_000);

afterAll(async () => {
  await app.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearDb();
  mailer.clear();
});

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: `/v1${url}`, payload, headers });
}

/** Sign up and click the emailed link — the shortest route to a usable account. */
async function signUpAndVerify(email: string, password = PASSWORD) {
  await post('/auth/signup', { email, password });
  const token = mailer.tokenFor(email);
  const res = await post('/auth/verify-email', { token });
  expect(res.statusCode).toBe(200);
  return res;
}

describe('POST /v1/auth/signup', () => {
  it(
    'creates an unverified account and emails a link',
    async () => {
      const res = await post('/auth/signup', {
        email: 'Ada@Example.com',
        password: PASSWORD,
        name: 'Ada',
      });

      // 202, not 201: nothing is usable yet.
      expect(res.statusCode).toBe(202);
      // And no session — issuing tokens here would let an unverified account in.
      expect(res.json().accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();

      const user = await User.findOne({ email: 'ada@example.com' }).select('+passwordHash');
      expect(user?.emailVerifiedAt).toBeNull();
      expect(user?.name).toBe('Ada');
      // Stored as a scrypt hash, never as the password.
      expect(user?.passwordHash).toMatch(/^scrypt\$/);
      expect(user?.passwordHash).not.toContain(PASSWORD);

      expect(mailer.lastTo('ada@example.com')?.subject).toMatch(/confirm/i);
    },
    SLOW,
  );

  /**
   * The enumeration defence (doc 13 §5.1). If the response differed at all — a
   * different status, a different message, a different field — the signup form
   * would be a way to test whether any address has an account here.
   */
  it(
    'answers identically for an address that already exists',
    async () => {
      const fresh = await post('/auth/signup', { email: 'new@example.com', password: PASSWORD });
      await post('/auth/signup', { email: 'taken@example.com', password: PASSWORD });
      mailer.clear();
      const duplicate = await post('/auth/signup', {
        email: 'taken@example.com',
        password: OTHER_PASSWORD,
      });

      expect(duplicate.statusCode).toBe(fresh.statusCode);
      expect(duplicate.json()).toEqual(fresh.json());
    },
    SLOW,
  );

  it(
    'tells the existing owner instead of the requester, and creates nothing',
    async () => {
      await post('/auth/signup', { email: 'taken@example.com', password: PASSWORD });
      mailer.clear();
      await post('/auth/signup', { email: 'taken@example.com', password: OTHER_PASSWORD });

      // The one party entitled to know is the account owner.
      const notice = mailer.lastTo('taken@example.com');
      expect(notice?.subject).toMatch(/already have/i);
      expect(notice?.text).toContain('No account was created');
      expect(await User.countDocuments({ email: 'taken@example.com' })).toBe(1);
    },
    SLOW,
  );

  it(
    'does not overwrite the existing password with the submitted one',
    async () => {
      await signUpAndVerify('taken@example.com', PASSWORD);
      const before = (await User.findOne({ email: 'taken@example.com' }).select('+passwordHash'))
        ?.passwordHash;

      await post('/auth/signup', { email: 'taken@example.com', password: OTHER_PASSWORD });

      const after = (await User.findOne({ email: 'taken@example.com' }).select('+passwordHash'))
        ?.passwordHash;
      // Otherwise "sign up with an address someone else owns" would be a
      // password reset without any proof of mailbox control.
      expect(after).toBe(before);
    },
    SLOW,
  );

  it('rejects a password under the minimum with a 400 envelope', async () => {
    const res = await post('/auth/signup', { email: 'a@example.com', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it(
    'rejects a common password with a reason the form can show',
    async () => {
      const res = await post('/auth/signup', {
        email: 'a@example.com',
        password: 'password123',
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details[0].path).toBe('password');
      expect(body.error.details[0].issue).toMatch(/too common/i);
    },
    SLOW,
  );
});

describe('POST /v1/auth/verify-email', () => {
  it(
    'stamps the account verified and signs the user in',
    async () => {
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      const res = await post('/auth/verify-email', { token: mailer.tokenFor('ada@example.com') });

      expect(res.statusCode).toBe(200);
      expect(res.json().accessToken).toEqual(expect.any(String));
      // Signed in immediately: the click already proved mailbox control.
      expect(String(res.headers['set-cookie'])).toContain(REFRESH_COOKIE);
      expect((await User.findOne({ email: 'ada@example.com' }))?.emailVerifiedAt).toBeInstanceOf(
        Date,
      );
    },
    SLOW,
  );

  /**
   * Mail clients prefetch links and users double-click. A read-then-write check
   * would let both requests through; the redemption is a single atomic update
   * filtered on `usedAt: null`.
   */
  it(
    'refuses a second use of the same link',
    async () => {
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      const token = mailer.tokenFor('ada@example.com');
      expect((await post('/auth/verify-email', { token })).statusCode).toBe(200);

      const again = await post('/auth/verify-email', { token });
      expect(again.statusCode).toBe(422);
      expect(again.json().error.message).toMatch(/invalid or has expired/i);
    },
    SLOW,
  );

  it('refuses an unknown token', async () => {
    const res = await post('/auth/verify-email', { token: 'x'.repeat(43) });
    expect(res.statusCode).toBe(422);
  });

  it(
    'refuses an expired token',
    async () => {
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      const token = mailer.tokenFor('ada@example.com');
      // Backdated rather than waiting: expiry is checked in the query, not left
      // to Mongo's TTL sweeper, precisely so it is exact.
      await AuthToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await post('/auth/verify-email', { token })).statusCode).toBe(422);
    },
    SLOW,
  );

  it('stores only a hash of the token, never the token', async () => {
    await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
    const token = mailer.tokenFor('ada@example.com');
    const stored = await AuthToken.findOne({});
    // A database dump must not be a set of working links.
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /v1/auth/login', () => {
  it(
    'signs in a verified account and sets the refresh cookie',
    async () => {
      await signUpAndVerify('ada@example.com');
      const res = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(res.json().accessToken).toEqual(expect.any(String));
      // The refresh token is in the cookie only — a body copy would defeat the
      // point of making it httpOnly.
      expect(res.json().refreshToken).toBeUndefined();
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toMatch(/SameSite=None/i);
    },
    SLOW,
  );

  it(
    'refuses an unverified account with a distinct code',
    async () => {
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      const res = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });

      // 403 with its own code, so the sign-in screen can offer a resend button
      // rather than showing "wrong password" for a correct one.
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    },
    SLOW,
  );

  it(
    'gives the same answer for a wrong password and an unknown address',
    async () => {
      await signUpAndVerify('ada@example.com');
      const wrongPassword = await post('/auth/login', {
        email: 'ada@example.com',
        password: OTHER_PASSWORD,
      });
      const unknownAddress = await post('/auth/login', {
        email: 'nobody@example.com',
        password: OTHER_PASSWORD,
      });

      // Distinguishing them would make the login form the oracle that signup is
      // carefully not.
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownAddress.statusCode).toBe(401);
      expect(unknownAddress.json()).toEqual(wrongPassword.json());
    },
    SLOW,
  );

  /**
   * The migration path (doc 13 D3). Accounts made by the old passwordless login
   * — and Google-only accounts — have `passwordHash: null`. Rejecting them would
   * strand every existing user.
   */
  it(
    'emails a set-password link for an account with no password',
    async () => {
      await User.create({
        email: 'legacy@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });
      const res = await post('/auth/login', { email: 'legacy@example.com', password: PASSWORD });

      // 202, not 401: nothing was wrong, but there is no session either.
      expect(res.statusCode).toBe(202);
      expect(res.json().passwordSetupRequired).toBe(true);
      expect(res.json().accessToken).toBeUndefined();
      expect(mailer.lastTo('legacy@example.com')?.subject).toMatch(/set a password/i);
    },
    SLOW,
  );

  it(
    'does not reject a short password before checking it',
    async () => {
      // A minLength on the login schema would 400 anyone whose password predates
      // the rule — locking them out of the very form they need to change it.
      await User.create({
        email: 'legacy@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });
      const res = await post('/auth/login', { email: 'legacy@example.com', password: 'abc' });
      expect(res.statusCode).not.toBe(400);
    },
    SLOW,
  );
});

describe('POST /v1/auth/forgot-password', () => {
  it(
    'answers identically for a known and an unknown address',
    async () => {
      await signUpAndVerify('ada@example.com');
      const known = await post('/auth/forgot-password', { email: 'ada@example.com' });
      const unknown = await post('/auth/forgot-password', { email: 'nobody@example.com' });

      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(unknown.json()).toEqual(known.json());
    },
    SLOW,
  );

  it(
    'emails only the address that exists',
    async () => {
      await signUpAndVerify('ada@example.com');
      mailer.clear();
      await post('/auth/forgot-password', { email: 'nobody@example.com' });
      expect(mailer.sent).toHaveLength(0);

      await post('/auth/forgot-password', { email: 'ada@example.com' });
      expect(mailer.lastTo('ada@example.com')?.subject).toMatch(/reset your password/i);
    },
    SLOW,
  );

  it(
    'offers to set a password, not to reset one, when there is none',
    async () => {
      await User.create({
        email: 'legacy@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });
      await post('/auth/forgot-password', { email: 'legacy@example.com' });
      // "Reset your password" would be a lie to someone who has never had one.
      expect(mailer.lastTo('legacy@example.com')?.subject).toMatch(/set a password/i);
    },
    SLOW,
  );

  /**
   * Issuing a new token retires the outstanding ones. Otherwise a link from an
   * email forwarded weeks ago still works alongside the newest one.
   */
  it(
    'invalidates the previous link when a new one is requested',
    async () => {
      await signUpAndVerify('ada@example.com');
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      const first = mailer.tokenFor('ada@example.com');
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      const second = mailer.tokenFor('ada@example.com');
      expect(second).not.toBe(first);

      expect(
        (await post('/auth/reset-password', { token: first, password: OTHER_PASSWORD })).statusCode,
      ).toBe(422);
      expect(
        (await post('/auth/reset-password', { token: second, password: OTHER_PASSWORD }))
          .statusCode,
      ).toBe(200);
    },
    SLOW,
  );
});

describe('POST /v1/auth/reset-password', () => {
  it(
    'writes the new password and signs the user in',
    async () => {
      await signUpAndVerify('ada@example.com');
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      const res = await post('/auth/reset-password', {
        token: mailer.tokenFor('ada@example.com'),
        password: OTHER_PASSWORD,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().accessToken).toEqual(expect.any(String));
      expect(
        (await post('/auth/login', { email: 'ada@example.com', password: OTHER_PASSWORD }))
          .statusCode,
      ).toBe(200);
      expect(
        (await post('/auth/login', { email: 'ada@example.com', password: PASSWORD })).statusCode,
      ).toBe(401);
    },
    SLOW,
  );

  /**
   * This is what makes a reset an actual eviction rather than a lock change with
   * the intruder still inside: bumping `tokenVersion` invalidates every
   * outstanding refresh token, which is where revocation is checked (doc 13 §5.3).
   */
  it(
    'kills a session that was open elsewhere',
    async () => {
      await signUpAndVerify('ada@example.com');
      const signedIn = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const oldCookie = /imapi_rt=([^;]+)/.exec(String(signedIn.headers['set-cookie']))?.[1] ?? '';
      expect(oldCookie).not.toBe('');

      await post('/auth/forgot-password', { email: 'ada@example.com' });
      await post('/auth/reset-password', {
        token: mailer.tokenFor('ada@example.com'),
        password: OTHER_PASSWORD,
      });

      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: oldCookie },
      });
      expect(refreshed.statusCode).toBe(401);
    },
    SLOW,
  );

  it(
    'refuses a second use of the same link',
    async () => {
      await signUpAndVerify('ada@example.com');
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      const token = mailer.tokenFor('ada@example.com');

      expect(
        (await post('/auth/reset-password', { token, password: OTHER_PASSWORD })).statusCode,
      ).toBe(200);
      expect(
        (await post('/auth/reset-password', { token, password: 'yet-another-long-one' }))
          .statusCode,
      ).toBe(422);
    },
    SLOW,
  );

  it(
    'verifies the address as a side effect',
    async () => {
      // Clicking a link sent to the mailbox proves control of it, which is
      // exactly what verification asks for — so an unverified user who resets is
      // not left unable to sign in.
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      await post('/auth/reset-password', {
        token: mailer.tokenFor('ada@example.com'),
        password: OTHER_PASSWORD,
      });

      expect((await User.findOne({ email: 'ada@example.com' }))?.emailVerifiedAt).toBeInstanceOf(
        Date,
      );
      expect(
        (await post('/auth/login', { email: 'ada@example.com', password: OTHER_PASSWORD }))
          .statusCode,
      ).toBe(200);
    },
    SLOW,
  );

  it(
    'redeems a set-password link through the same endpoint',
    async () => {
      await User.create({
        email: 'legacy@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });
      await post('/auth/login', { email: 'legacy@example.com', password: PASSWORD });
      const res = await post('/auth/reset-password', {
        token: mailer.tokenFor('legacy@example.com'),
        password: OTHER_PASSWORD,
      });

      expect(res.statusCode).toBe(200);
      expect(
        (await post('/auth/login', { email: 'legacy@example.com', password: OTHER_PASSWORD }))
          .statusCode,
      ).toBe(200);
    },
    SLOW,
  );

  it(
    'drops every other outstanding link',
    async () => {
      await signUpAndVerify('ada@example.com');
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      await post('/auth/reset-password', {
        token: mailer.tokenFor('ada@example.com'),
        password: OTHER_PASSWORD,
      });
      // An attacker who requested a reset before being locked out must not keep
      // a way back in.
      expect(await AuthToken.countDocuments({})).toBe(0);
    },
    SLOW,
  );
});

describe('POST /v1/auth/change-password', () => {
  it(
    'requires the current password',
    async () => {
      await signUpAndVerify('ada@example.com');
      const session = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const token = session.json().accessToken as string;

      const wrong = await post(
        '/auth/change-password',
        { currentPassword: 'not-the-password', newPassword: OTHER_PASSWORD },
        authHeader(token),
      );
      // An authenticated session is not enough: this is what stops someone at a
      // borrowed laptop from taking the account.
      expect(wrong.statusCode).toBe(401);

      const right = await post(
        '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
        authHeader(token),
      );
      expect(right.statusCode).toBe(200);
    },
    SLOW,
  );

  it(
    'signs out every other session',
    async () => {
      await signUpAndVerify('ada@example.com');
      const first = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const second = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const otherCookie = /imapi_rt=([^;]+)/.exec(String(second.headers['set-cookie']))?.[1] ?? '';

      await post(
        '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
        authHeader(first.json().accessToken as string),
      );

      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: otherCookie },
      });
      expect(refreshed.statusCode).toBe(401);
    },
    SLOW,
  );

  it(
    'points a passwordless account at the email flow instead',
    async () => {
      await User.create({
        email: 'legacy@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });
      const dev = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { email: 'legacy@example.com' },
      });
      const res = await post(
        '/auth/change-password',
        { currentPassword: 'anything', newPassword: OTHER_PASSWORD },
        authHeader(dev.json().accessToken as string),
      );
      // There is no current password to check, so this route cannot authorise
      // the change; the emailed link can, because it proves mailbox control.
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/forgot password/i);
    },
    SLOW,
  );
});

describe('POST /v1/auth/logout', () => {
  it(
    'ends every session, not just this browser',
    async () => {
      await signUpAndVerify('ada@example.com');
      const first = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const second = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const otherCookie = /imapi_rt=([^;]+)/.exec(String(second.headers['set-cookie']))?.[1] ?? '';

      const res = await post('/auth/logout', undefined, {
        ...authHeader(first.json().accessToken as string),
        ...csrfHeader(),
      });
      expect(res.statusCode).toBe(204);

      // Without the tokenVersion bump, "sign out" would only mean "forget" — a
      // copy of the cookie taken earlier would still work.
      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: otherCookie },
      });
      expect(refreshed.statusCode).toBe(401);
    },
    SLOW,
  );

  it(
    'refuses without the CSRF header',
    async () => {
      await signUpAndVerify('ada@example.com');
      const session = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const res = await post('/auth/logout', undefined, {
        ...authHeader(session.json().accessToken as string),
      });
      expect(res.statusCode).toBe(403);
    },
    SLOW,
  );
});

describe('POST /v1/auth/resend-verification', () => {
  it(
    'answers identically for unknown, unverified and already-verified addresses',
    async () => {
      await post('/auth/signup', { email: 'unverified@example.com', password: PASSWORD });
      await signUpAndVerify('verified@example.com');

      const unknown = await post('/auth/resend-verification', { email: 'nobody@example.com' });
      const unverified = await post('/auth/resend-verification', {
        email: 'unverified@example.com',
      });
      const verified = await post('/auth/resend-verification', { email: 'verified@example.com' });

      // Answering differently would say which addresses are registered *and*
      // which are confirmed.
      expect(unverified.json()).toEqual(unknown.json());
      expect(verified.json()).toEqual(unknown.json());
      expect(unverified.statusCode).toBe(unknown.statusCode);
    },
    SLOW,
  );

  it(
    'sends only to an unverified address',
    async () => {
      await post('/auth/signup', { email: 'unverified@example.com', password: PASSWORD });
      await signUpAndVerify('verified@example.com');
      mailer.clear();

      await post('/auth/resend-verification', { email: 'nobody@example.com' });
      await post('/auth/resend-verification', { email: 'verified@example.com' });
      expect(mailer.sent).toHaveLength(0);

      await post('/auth/resend-verification', { email: 'unverified@example.com' });
      expect(mailer.sent).toHaveLength(1);
    },
    SLOW,
  );
});

describe('POST /v1/auth/refresh', () => {
  it(
    'does not rotate the cookie value',
    async () => {
      // Rotation plus a shared browser cookie is a multi-tab race: the second tab
      // presents the value it was already holding and gets signed out. The cookie
      // is httpOnly, Secure and CSRF-guarded, and tokenVersion can revoke it, so
      // a stable value is the better trade (doc 13 §4.3).
      await signUpAndVerify('ada@example.com');
      const session = await post('/auth/login', { email: 'ada@example.com', password: PASSWORD });
      const cookie = /imapi_rt=([^;]+)/.exec(String(session.headers['set-cookie']))?.[1] ?? '';

      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: cookie },
      });
      const returned = /imapi_rt=([^;]+)/.exec(String(refreshed.headers['set-cookie']))?.[1] ?? '';
      expect(returned).toBe(cookie);

      // And it still works a second time, which is the property the race broke.
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: cookie },
      });
      expect(again.statusCode).toBe(200);
    },
    SLOW,
  );

  it('refuses without the CSRF header', async () => {
    const res = await post('/auth/refresh', undefined);
    expect(res.statusCode).toBe(403);
  });

  it(
    'clears a cookie that can never work again',
    async () => {
      // Otherwise every future page load spends a request rediscovering that.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: csrfHeader(),
        cookies: { [REFRESH_COOKIE]: 'not.a.jwt' },
      });
      expect(res.statusCode).toBe(401);
      expect(String(res.headers['set-cookie'])).toContain(REFRESH_COOKIE);
    },
    SLOW,
  );
});

/**
 * The rest of this file runs with rate limiting off, because it is off by
 * default in the harness. These tests build their own server with it on: the
 * global limit is deliberately generous here so that what is being measured is
 * the *per-route* limit and not the global one.
 */
describe('credential rate limits', () => {
  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await buildTestServer({ rateLimit: { max: 10_000 }, mailer });
  });

  afterAll(async () => {
    await limited.close();
  });

  function attempt(email: string) {
    return limited.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'whatever-it-is-wrong' },
    });
  }

  it(
    'stops a password-guessing run at ten attempts a minute',
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        statuses.push((await attempt('target@example.com')).statusCode);
      }
      // The global 100/min would allow 144,000 guesses a day against one
      // account; this is the limit that makes the difference.
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect(statuses[11]).toBe(429);
    },
    SLOW,
  );

  /**
   * The budget follows the account, not the caller — so an attacker with a
   * hundred IPs still gets ten guesses against one password, and one person
   * being attacked does not lock everybody else out.
   */
  it(
    'gives a different account its own budget',
    async () => {
      for (let i = 0; i < 11; i += 1) {
        await attempt('victim@example.com');
      }
      expect((await attempt('victim@example.com')).statusCode).toBe(429);
      expect((await attempt('bystander@example.com')).statusCode).toBe(401);
    },
    SLOW,
  );

  it(
    'rations password-reset emails by the hour',
    async () => {
      const send = () =>
        limited.inject({
          method: 'POST',
          url: '/v1/auth/forgot-password',
          payload: { email: 'flooded@example.com' },
        });
      expect((await send()).statusCode).toBe(202);
      expect((await send()).statusCode).toBe(202);
      expect((await send()).statusCode).toBe(202);
      // Unbounded, this endpoint is a way to flood somebody's inbox using our
      // sending domain — which gets the domain blocklisted.
      expect((await send()).statusCode).toBe(429);
    },
    SLOW,
  );
});

/**
 * What happens when the mail transport is misconfigured — an unverified sending
 * domain, a bad API key. This used to be invisible: signup answered
 * "202 Check your inbox" and only logged the rejection, so a deployment with a
 * wrong EMAIL_FROM looked healthy while no user could ever verify an account.
 */
describe('when email delivery is broken', () => {
  let broken: FastifyInstance;

  beforeAll(async () => {
    broken = await buildTestServer({ mailer: createFailingMailer() });
  });

  afterAll(async () => {
    await broken.close();
  });

  function post(url: string, payload: unknown) {
    return broken.inject({ method: 'POST', url: `/v1${url}`, payload });
  }

  it(
    'tells the user signup could not email them, instead of claiming it did',
    async () => {
      const res = await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });

      expect(res.statusCode).toBe(500);
      // Names what to do next. A bare "internal error" would read as "signup
      // failed", and retrying is exactly what the rate limit then refuses.
      expect(res.json().error.message).toMatch(/could not send the confirmation email/i);
      expect(res.json().error.message).toMatch(/resend the link/i);
    },
    SLOW,
  );

  it(
    'still creates the account, so the resend path can recover it',
    async () => {
      // Failing the request must not roll the user back — otherwise the address
      // is left half-registered and the next attempt hits the unique index.
      await post('/auth/signup', { email: 'ada@example.com', password: PASSWORD });
      const user = await User.findOne({ email: 'ada@example.com' });
      expect(user).not.toBeNull();
      expect(user?.emailVerifiedAt).toBeNull();
    },
    SLOW,
  );

  /**
   * The property that is easy to break while making failures loud, and the
   * reason both signup branches report identically: if only the create branch
   * errored, a broken mailer would turn signup into the account-existence
   * oracle the whole endpoint is shaped to avoid — unknown address 500s, known
   * address answers 202.
   */
  it(
    'still answers identically for a new and an existing address',
    async () => {
      await User.create({
        email: 'taken@example.com',
        authProvider: 'email',
        emailVerifiedAt: new Date(),
      });

      const fresh = await post('/auth/signup', { email: 'new@example.com', password: PASSWORD });
      const existing = await post('/auth/signup', {
        email: 'taken@example.com',
        password: PASSWORD,
      });

      expect(existing.statusCode).toBe(fresh.statusCode);
      expect(existing.json()).toEqual(fresh.json());
    },
    SLOW,
  );

  /**
   * The opposite call, and it is not inconsistency. Here the "no such address"
   * branch sends nothing and cannot fail, so surfacing a failure on the other
   * branch would answer the question this endpoint returns a fixed response to
   * refuse: an error means the account exists.
   */
  it(
    'stays silent on forgot-password, whether or not the address exists',
    async () => {
      await User.create({
        email: 'known@example.com',
        authProvider: 'email',
        passwordHash: 'scrypt$65536$8$1$c2FsdA$aGFzaA',
        emailVerifiedAt: new Date(),
      });

      const known = await post('/auth/forgot-password', { email: 'known@example.com' });
      const unknown = await post('/auth/forgot-password', { email: 'nobody@example.com' });

      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(known.json()).toEqual(unknown.json());
    },
    SLOW,
  );

  it(
    'stays silent on resend-verification too',
    async () => {
      // Same reasoning as forgot-password. A loud failure would reveal that the
      // address exists *and* has not been verified.
      await User.create({
        email: 'unverified@example.com',
        authProvider: 'email',
        emailVerifiedAt: null,
      });

      const pending = await post('/auth/resend-verification', {
        email: 'unverified@example.com',
      });
      const unknown = await post('/auth/resend-verification', { email: 'nobody@example.com' });

      expect(pending.statusCode).toBe(202);
      expect(pending.json()).toEqual(unknown.json());
    },
    SLOW,
  );
});

describe('passwordProblems', () => {
  it('accepts a long, unremarkable password', () => {
    expect(passwordProblems('correct-horse-battery', 'ada@example.com')).toEqual([]);
  });

  it('requires length rather than symbol classes', () => {
    // NIST 800-63B: mandated composition rules mostly produce `Password1!`.
    expect(passwordProblems('short1!')).toEqual([`Use at least ${MIN_PASSWORD_LENGTH} characters`]);
    expect(passwordProblems('all lower case letters here')).toEqual([]);
  });

  it('rejects the handful of passwords that fall to a first guess', () => {
    expect(passwordProblems('password123')[0]).toMatch(/too common/i);
    // Case-insensitively — otherwise the deny-list is bypassed by shift.
    expect(passwordProblems('PASSWORD123')[0]).toMatch(/too common/i);
  });

  it('rejects a password derived from the email', () => {
    // The address is public and is submitted alongside the password, so this is
    // a password the attacker already has.
    expect(passwordProblems('ada@example.com', 'ada@example.com')[0]).toMatch(/email address/i);
    expect(passwordProblems('adalovelace', 'adalovelace@example.com')[0]).toMatch(/email address/i);
  });

  it('reports every problem at once', () => {
    // So the form shows them together instead of one per submission. 'password'
    // against that address breaks all three rules: too short, too common, and
    // equal to the local part.
    expect(passwordProblems('password', 'password@example.com')).toHaveLength(3);
  });
});

/**
 * The generated Auth API (Phase 3 §5–§11).
 *
 *     POST /signUp    POST /signIn    POST /refresh    GET /me    POST /logout
 *
 * These serve the **mock API's own end users**, not InstantMockAPI's. See
 * `./tokens.ts` for why none of `packages/auth` is reused.
 *
 * ## Everything here is per project
 *
 * Every query filters on `projectId` and every token is signed with that
 * project's key. §14's cross-project rule is therefore a property of the code
 * shape rather than a check: there is no query in this file that could return
 * another project's user, because none of them omits the filter.
 *
 * ## What never leaves
 *
 * §10 and §23: no `passwordHash`, no refresh token beyond the response that
 * mints it, no session row. `publicUser` is the only shape a user is ever
 * serialized through, so there is one place to audit rather than five.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@instantmockapi/shared';
import { MockSession, MockUser, ensureAuthSecret, type IMockUser } from '@instantmockapi/db';
import { hashPassword, verifyPassword } from '@instantmockapi/auth';
import type { HostedAuthConfig } from '@instantmockapi/generator-hosting';

import {
  bearerToken,
  durationSeconds,
  signMockToken,
  verifyMockToken,
  type MockTokenType,
} from './tokens.js';

/** §7/§8 defaults, used when a stored duration predates the grammar. */
const ACCESS_TTL_FALLBACK = 15 * 60;
const REFRESH_TTL_FALLBACK = 7 * 24 * 60 * 60;

/** §5: long enough to matter, short enough not to be a denial-of-service vector. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 320;

/** Refresh tokens are opaque random strings, not JWTs — see `issueSession`. */
const REFRESH_BYTES = 32;

const COOKIE_ACCESS = 'ima_access';
const COOKIE_REFRESH = 'ima_refresh';

function unauthorized(): AppError {
  /*
   * One message for every failure (§6, §14).
   *
   * Wrong password, unknown address, expired token, revoked session, foreign
   * project — all of them answer identically. Distinguishing them turns the
   * endpoint into an account-existence oracle, which is what §6's "do not reveal
   * whether the email exists" forbids. `verifyMockToken`'s reasons exist for
   * logs, not for this.
   */
  return new AppError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
}

function invalid(message: string, details?: { path: string; issue: string }[]): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * The only shape a `MockUser` is serialized through (§10, §22).
 *
 * A single function rather than a field list at each call site, so "never return
 * the password hash" is enforced in one place instead of remembered in five.
 */
export function publicUser(user: IMockUser): Record<string, unknown> {
  return {
    id: String(user._id),
    email: user.email,
    ...user.fields,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read and normalise the credential fields of a request body.
 *
 * Length caps before anything else: `hashPassword` is scrypt at 64MB, so an
 * unbounded password field is a memory-exhaustion vector that costs the attacker
 * one request.
 */
function credentials(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('A JSON body with email and password is required');
  }
  const raw = body as Record<string, unknown>;
  const details: { path: string; issue: string }[] = [];

  const email = typeof raw['email'] === 'string' ? raw['email'].trim().toLowerCase() : '';
  const password = typeof raw['password'] === 'string' ? raw['password'] : '';

  if (email === '' || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    details.push({ path: 'email', issue: 'A valid email address is required' });
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    details.push({
      path: 'password',
      issue: `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
    });
  }
  if (details.length > 0) {
    throw invalid('Invalid credentials payload', details);
  }
  return { email, password };
}

/**
 * Read the project's declared custom fields off the body (§5).
 *
 * Only declared names are read, so a caller cannot smuggle `passwordHash` or an
 * arbitrary key into the stored document. The reserved names are rejected by
 * `validateIPS` before a project can declare them, which means this loop's
 * allowlist can never contain one.
 */
function customFields(
  body: unknown,
  declared: HostedAuthConfig['userFields'],
): Record<string, unknown> {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  const details: { path: string; issue: string }[] = [];

  for (const field of declared) {
    const value = raw[field.name];
    if (value === undefined || value === null) {
      if (field.required) {
        details.push({ path: field.name, issue: `${field.name} is required` });
      }
      continue;
    }
    const actual = typeof value;
    if (actual !== field.type) {
      details.push({ path: field.name, issue: `${field.name} must be a ${field.type}` });
      continue;
    }
    fields[field.name] = value;
  }

  if (details.length > 0) {
    throw invalid('Invalid signup fields', details);
  }
  return fields;
}

interface AuthDeps {
  projectId: string;
  auth: HostedAuthConfig;
}

/**
 * Mint a refresh session: an opaque random token, with only its hash stored.
 *
 * **Not a JWT.** A signed refresh token cannot be revoked without a server-side
 * list anyway, so making it a JWT would add a payload nobody reads while still
 * requiring the row — and would put a second signed credential in circulation
 * for an attacker to try against the access-token verifier. Opaque plus a hashed
 * row is strictly less machinery and strictly more revocable.
 */
async function issueSession(
  deps: AuthDeps,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(REFRESH_BYTES).toString('base64url');
  const ttl = durationSeconds(deps.auth.refreshTokenExpiresIn, REFRESH_TTL_FALLBACK);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await MockSession.create({
    projectId: deps.projectId,
    userId,
    tokenHash: sha256(token),
    expiresAt,
  });

  return { token, expiresAt };
}

async function issueAccess(
  deps: AuthDeps,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const secret = await ensureAuthSecret(deps.projectId);
  return signMockToken({
    secret,
    projectId: deps.projectId,
    userId,
    type: 'access',
    ttlSeconds: durationSeconds(deps.auth.accessTokenExpiresIn, ACCESS_TTL_FALLBACK),
  });
}

/**
 * Set or clear the credential cookies (§9).
 *
 * `httpOnly` so script cannot read them, `secure` outside development so they
 * never cross plaintext, `sameSite: 'lax'` as a default that survives a
 * top-level navigation back to the app while refusing cross-site POSTs.
 *
 * Written with `reply.header` rather than `@fastify/cookie` because the runtime
 * does not register that plugin and adding it for two `Set-Cookie` lines would
 * be a dependency for a string.
 */
function setAuthCookies(
  reply: FastifyReply,
  params: {
    access: string;
    refresh: string;
    accessMaxAge: number;
    refreshMaxAge: number;
    secure: boolean;
  },
): void {
  const flags = (maxAge: number): string =>
    [
      `Max-Age=${maxAge}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      ...(params.secure ? ['Secure'] : []),
    ].join('; ');

  void reply.header('set-cookie', [
    `${COOKIE_ACCESS}=${params.access}; ${flags(params.accessMaxAge)}`,
    `${COOKIE_REFRESH}=${params.refresh}; ${flags(params.refreshMaxAge)}`,
  ]);
}

function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  const flags = [
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
  void reply.header('set-cookie', [`${COOKIE_ACCESS}=; ${flags}`, `${COOKIE_REFRESH}=; ${flags}`]);
}

/** Parse one cookie out of the header, without a cookie plugin. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * The credential on a request: `Authorization` first, then the cookie (§9).
 *
 * Header first so an explicit token always wins over a stale cookie left in the
 * browser — otherwise a developer testing with `curl -H Authorization` against a
 * cookie-mode project would silently be authenticated as whoever the cookie
 * belongs to.
 */
export function requestCredential(request: FastifyRequest): string | null {
  return (
    bearerToken(request.headers.authorization) ?? cookieValue(request.headers.cookie, COOKIE_ACCESS)
  );
}

/**
 * Resolve the caller of a protected request, or throw 401 (§14).
 *
 * Checks, in order: a credential exists, it verifies against **this project's**
 * key, it is an access token and not a refresh token, and the user it names
 * still exists in this project. The last one matters — a token outlives a
 * deleted account, and §23's "do not trust client-provided user IDs" means the
 * `sub` claim is a lookup key, not an identity.
 */
export async function authenticateRequest(
  deps: AuthDeps,
  request: FastifyRequest,
): Promise<IMockUser> {
  const token = requestCredential(request);
  if (token === null) {
    throw unauthorized();
  }

  const secret = await ensureAuthSecret(deps.projectId);
  const verified = await verifyMockToken({
    secret,
    projectId: deps.projectId,
    token,
    expect: 'access' satisfies MockTokenType,
  });
  if (!verified.ok) {
    throw unauthorized();
  }

  const user = await MockUser.findOne({ _id: verified.claims.sub, projectId: deps.projectId });
  if (!user) {
    throw unauthorized();
  }
  return user;
}

/**
 * A signin-shaped response.
 *
 * In cookie mode the tokens are set as cookies **and omitted from the body**, so
 * a browser client cannot accidentally persist them to `localStorage` — which is
 * the whole point of choosing cookie mode. The body still carries the user, so
 * the caller has something to render.
 */
async function sessionResponse(
  deps: AuthDeps,
  reply: FastifyReply,
  user: IMockUser,
  secureCookies: boolean,
): Promise<Record<string, unknown>> {
  const access = await issueAccess(deps, String(user._id));
  const refresh = deps.auth.refresh ? await issueSession(deps, String(user._id)) : null;

  if (deps.auth.cookieAuth) {
    setAuthCookies(reply, {
      access: access.token,
      refresh: refresh?.token ?? '',
      accessMaxAge: Math.max(0, Math.floor((access.expiresAt.getTime() - Date.now()) / 1000)),
      refreshMaxAge:
        refresh === null
          ? 0
          : Math.max(0, Math.floor((refresh.expiresAt.getTime() - Date.now()) / 1000)),
      secure: secureCookies,
    });
    return { user: publicUser(user) };
  }

  return {
    user: publicUser(user),
    accessToken: access.token,
    expiresAt: access.expiresAt.toISOString(),
    ...(refresh === null ? {} : { refreshToken: refresh.token }),
  };
}

/* ────────────────────────── the five endpoints ────────────────────────── */

export async function signUp(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean,
): Promise<FastifyReply> {
  const { email, password } = credentials(request.body);
  const fields = customFields(request.body, deps.auth.userFields);

  const passwordHash = await hashPassword(password);

  let user: IMockUser;
  try {
    user = await MockUser.create({ projectId: deps.projectId, email, passwordHash, fields });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      /*
       * §5 requires duplicates be prevented, and this is the one place where
       * revealing existence is unavoidable: a signUp that silently succeeded
       * would leave the caller believing they had an account they cannot use.
       *
       * 409 rather than a generic error, because the client's remedy is
       * specific — sign in instead.
       */
      throw new AppError({
        code: 'CONFLICT',
        message: 'An account with that email already exists',
      });
    }
    throw error;
  }

  return reply.status(201).send(await sessionResponse(deps, reply, user, secureCookies));
}

export async function signIn(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean,
): Promise<FastifyReply> {
  const { email, password } = credentials(request.body);

  const user = await MockUser.findOne({ projectId: deps.projectId, email });
  if (!user) {
    /*
     * §6: a generic message, and the cost of *not* hashing here is a timing
     * side channel that answers "does this address exist" in a few
     * milliseconds. scrypt at 64MB is slow enough that the difference is
     * trivially measurable, so an unknown address pays the same cost as a
     * wrong password.
     */
    await hashPassword(password);
    throw unauthorized();
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw unauthorized();
  }

  return reply.status(200).send(await sessionResponse(deps, reply, user, secureCookies));
}

export async function refresh(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean,
): Promise<FastifyReply> {
  const presented =
    (typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)['refreshToken']
      : undefined) ?? cookieValue(request.headers.cookie, COOKIE_REFRESH);

  if (typeof presented !== 'string' || presented === '') {
    throw unauthorized();
  }

  const session = await MockSession.findOne({
    projectId: deps.projectId,
    tokenHash: sha256(presented),
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized();
  }

  if (session.revokedAt !== null) {
    /*
     * §8's rotation, and the reason `replacedBy` exists.
     *
     * A revoked session with a successor means somebody presented a token that
     * was already exchanged — the signature of a stolen refresh token, since a
     * legitimate client holds only its newest one. The whole chain is dropped
     * rather than just this link: if the token is in two places, neither can be
     * trusted, and forcing a fresh signin is the only safe answer.
     */
    await MockSession.updateMany(
      { projectId: deps.projectId, userId: session.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized();
  }

  const user = await MockUser.findOne({ _id: session.userId, projectId: deps.projectId });
  if (!user) {
    throw unauthorized();
  }

  const next = await issueSession(deps, String(user._id));
  session.revokedAt = new Date();
  session.replacedBy = (await MockSession.findOne({ tokenHash: sha256(next.token) }))?._id ?? null;
  await session.save();

  const access = await issueAccess(deps, String(user._id));

  if (deps.auth.cookieAuth) {
    setAuthCookies(reply, {
      access: access.token,
      refresh: next.token,
      accessMaxAge: Math.max(0, Math.floor((access.expiresAt.getTime() - Date.now()) / 1000)),
      refreshMaxAge: Math.max(0, Math.floor((next.expiresAt.getTime() - Date.now()) / 1000)),
      secure: secureCookies,
    });
    return reply.status(200).send({ user: publicUser(user) });
  }

  return reply.status(200).send({
    user: publicUser(user),
    accessToken: access.token,
    expiresAt: access.expiresAt.toISOString(),
    refreshToken: next.token,
  });
}

export async function me(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const user = await authenticateRequest(deps, request);
  return reply.status(200).send({ user: publicUser(user) });
}

export async function logout(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean,
): Promise<FastifyReply> {
  /*
   * §11: revoke the refresh session and clear the cookies. Access tokens are
   * stateless and expire on their own, which §11 accepts explicitly — the
   * alternative is a denylist checked on every request, and a 15-minute window
   * is the price of not having one.
   *
   * Authenticating first would make logout fail for the caller who most needs
   * it: someone whose access token has already lapsed but who still holds a
   * refresh token. So the refresh token alone is sufficient, and a logout with
   * no valid credential still answers 204 rather than 401 — there is nothing to
   * reveal and nothing the caller could do differently.
   */
  const presented =
    (typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)['refreshToken']
      : undefined) ?? cookieValue(request.headers.cookie, COOKIE_REFRESH);

  if (typeof presented === 'string' && presented !== '') {
    await MockSession.updateOne(
      { projectId: deps.projectId, tokenHash: sha256(presented), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }

  if (deps.auth.cookieAuth) {
    clearAuthCookies(reply, secureCookies);
  }
  return reply.status(204).send();
}

/** Constant-time compare, for anywhere a token is checked outside the verifier. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

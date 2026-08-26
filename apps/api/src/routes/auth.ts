/**
 * Auth routes (doc 08 §2, doc 13 §1).
 *
 * ## Where the access token and the refresh token live
 *
 * The response body carries the **access token** only, and the web app keeps it
 * in a variable — never in `localStorage`, so an XSS bug cannot read a durable
 * credential out of storage. The **refresh token** goes back as an `HttpOnly`
 * cookie, which script cannot read at all and which survives a page reload. See
 * [auth-cookies.ts](../auth-cookies.ts) for the attributes and the CSRF guard
 * that `SameSite=None` makes necessary.
 *
 * ## Refresh does not rotate the cookie
 *
 * A shared browser cookie plus rotation is a multi-tab race: two tabs refresh at
 * once, the first rotates, the second presents the value it was already holding
 * and gets signed out. The cookie is httpOnly, Secure and CSRF-guarded, and
 * `tokenVersion` can revoke it at any time, so a stable-but-revocable refresh
 * token is the better trade. It rotates on password change and on sign-out.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { User, type IUser } from '@instantmockapi/db';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  verifyGoogleCode,
  type AuthUser,
} from '@instantmockapi/auth';
import { findOrCreateGoogleUser } from '../google-auth.js';
import { toUserView } from '../serializers.js';
import { isObjectIdHex } from '../access.js';
import { createMailer, type Mailer } from '../email.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  requireCsrfHeader,
  setRefreshCookie,
} from '../auth-cookies.js';
import {
  EMAIL_SEND_LIMIT,
  LOGIN_LIMIT,
  REDEEM_LIMIT,
  REFRESH_LIMIT,
  SIGNUP_LIMIT,
} from '../auth-rate-limits.js';
import {
  MIN_PASSWORD_LENGTH,
  changePassword,
  logIn,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signOutEverywhere,
  signUp,
  verifyEmail,
  type AuthServiceDeps,
} from '../auth-service.js';

export interface AuthRouteOptions {
  config: EnvConfig;
  /** Injected by tests; production builds one from config. */
  mailer?: Mailer;
}

const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';

const emailField = { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 } as const;

/**
 * Only a floor and a ceiling here; the real rules are in
 * [auth-service.ts](../auth-service.ts) so the message can explain itself.
 *
 * The maximum is not a strength policy — it is a denial-of-service guard. scrypt
 * hashes whatever it is handed, so an unbounded password field is an invitation
 * to post a megabyte of it.
 */
const passwordField = {
  type: 'string',
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: 200,
} as const;

const tokenField = { type: 'string', minLength: 16, maxLength: 200 } as const;

/**
 * The response every neutral endpoint gives.
 *
 * One shared constant rather than a literal per route: these have to be
 * byte-identical whether or not the address exists, and three separately-written
 * messages would eventually stop matching.
 */
const NEUTRAL_EMAIL_RESPONSE = {
  ok: true,
  message: 'If that address has an account, we have sent it an email.',
} as const;

async function issueSession(
  user: IUser,
  config: EnvConfig,
  reply: FastifyReply,
): Promise<{ accessToken: string; expiresIn: number; user: ReturnType<typeof toUserView> }> {
  const authUser: AuthUser = {
    id: String(user._id),
    email: user.email,
    plan: user.plan,
    tokenVersion: user.tokenVersion,
  };
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(authUser, config),
    issueRefreshToken(authUser, config),
  ]);
  setRefreshCookie(reply, refreshToken);
  return { accessToken, expiresIn: config.jwtExpiresIn, user: toUserView(user) };
}

function authenticatedUserId(sub: string | undefined): string {
  if (sub === undefined || !isObjectIdHex(sub)) {
    throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
  return sub;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  const { config } = options;
  const deps: AuthServiceDeps = {
    config,
    mailer: options.mailer ?? createMailer(config),
  };

  app.post(
    '/auth/signup',
    {
      config: { rateLimit: SIGNUP_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: emailField,
            password: passwordField,
            name: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string; name?: string };
      await signUp(body, deps);
      // 202, and no session. The account is unusable until the emailed link is
      // clicked, so returning tokens here would be a lie — and the response says
      // nothing about whether an account was created (doc 13 §5.1).
      return reply.status(202).send({
        ok: true,
        message: 'Check your inbox for a link to confirm your email address.',
      });
    },
  );

  app.post(
    '/auth/login',
    {
      config: { rateLimit: LOGIN_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: emailField,
            // Deliberately NOT `passwordField`: a minLength here would reject a
            // short password with a 422 before it is checked, which tells an
            // attacker the length rule and, worse, means users whose password
            // predates the rule can never sign in to change it.
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const outcome = await logIn(body, deps);

      if (outcome.kind === 'emailed-set-password') {
        // 202: nothing was wrong, but there is no session either — the account
        // has no password yet and one has been offered by email.
        return reply.status(202).send({
          ok: true,
          passwordSetupRequired: true,
          message: 'This account has no password yet. We have emailed you a link to set one.',
        });
      }

      return reply.status(200).send(await issueSession(outcome.user, config, reply));
    },
  );

  /**
   * Sign in as any address, with no credentials — **never registered in
   * production**.
   *
   * This exists because the alternative is worse. Resetting a local database
   * would otherwise mean completing an email verification round trip before you
   * can look at anything, and the whole test suite would have to hash a password
   * per fixture user (scrypt at 64MB, several hundred times).
   *
   * The guard is registration-time, not a check inside the handler: the route
   * simply does not exist in production, so there is no code path to reach even
   * if something later forgets to check. `assertProductionSecrets` and this
   * condition read the same `nodeEnv`.
   */
  if (config.nodeEnv !== 'production') {
    app.post(
      '/auth/dev-login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            additionalProperties: false,
            properties: {
              email: emailField,
              name: { type: 'string', maxLength: 80 },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { email: string; name?: string };
        const email = body.email.trim().toLowerCase();
        const user = await User.findOneAndUpdate(
          { email },
          {
            $setOnInsert: {
              email,
              name: body.name ?? null,
              authProvider: 'email',
              // Verified on creation: an unverified account cannot sign in, and
              // the point of this route is not having to check a mailbox.
              emailVerifiedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after' },
        );
        const session = await issueSession(user, config, reply);
        // The refresh token is also in the body here, unlike every other route.
        // Tests drive the API through `inject` and have no cookie jar, so
        // without this they cannot exercise refresh at all.
        const refreshToken = await issueRefreshToken(
          {
            id: String(user._id),
            email: user.email,
            plan: user.plan,
            tokenVersion: user.tokenVersion,
          },
          config,
        );
        return reply.status(200).send({ ...session, refreshToken });
      },
    );
  }

  app.post(
    '/auth/refresh',
    {
      config: { rateLimit: REFRESH_LIMIT },
      // The cookie is sent cross-site, so this endpoint needs the CSRF guard.
      onRequest: [async (request) => requireCsrfHeader(request)],
    },
    async (request, reply) => {
      const refreshToken = readRefreshCookie(request);
      if (refreshToken === null) {
        // 401 with no cookie is the *normal* answer for a first-time visitor:
        // the web app calls this on boot to find out whether it has a session.
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Not signed in' });
      }

      const claims = await verifyRefreshToken(refreshToken, config);
      if (!claims.ok || !isObjectIdHex(claims.value.sub)) {
        // Clear on the way out: a cookie that can never succeed would otherwise
        // make every future boot spend a request discovering that again.
        clearRefreshCookie(reply);
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }

      const user = await User.findById(claims.value.sub);
      // This is the one place revocation is checked (doc 13 §5.3). Access tokens
      // stay stateless — the alternative is a database read on every single
      // authenticated request — so `tokenVersion` is compared here, where the
      // user is being loaded anyway.
      if (!user || user.tokenVersion !== claims.value.tokenVersion) {
        clearRefreshCookie(reply);
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }

      // Note the cookie is re-set with the *same* token, not a new one: this
      // extends its lifetime on an active session without the multi-tab race
      // that rotation causes.
      return reply.status(200).send(await issueSession(user, config, reply));
    },
  );

  app.post(
    '/auth/verify-email',
    {
      config: { rateLimit: REDEEM_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: tokenField },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      const user = await verifyEmail(token);
      // Signed in immediately: the click proved control of the mailbox, and
      // making someone type their password again right afterwards is friction
      // that buys nothing.
      return reply.status(200).send(await issueSession(user, config, reply));
    },
  );

  app.post(
    '/auth/resend-verification',
    {
      config: { rateLimit: EMAIL_SEND_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: emailField },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      await resendVerification(email, deps);
      return reply.status(202).send(NEUTRAL_EMAIL_RESPONSE);
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      config: { rateLimit: EMAIL_SEND_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: emailField },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      await requestPasswordReset(email, deps);
      // Identical body and status whatever was found. This endpoint is the
      // easiest account-existence oracle to build by accident.
      return reply.status(202).send(NEUTRAL_EMAIL_RESPONSE);
    },
  );

  app.post(
    '/auth/reset-password',
    {
      config: { rateLimit: REDEEM_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: { token: tokenField, password: passwordField },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { token: string; password: string };
      const user = await resetPassword(body);
      // The reset bumped tokenVersion, so every other session is already dead;
      // this response is what keeps *this* one alive.
      return reply.status(200).send(await issueSession(user, config, reply));
    },
  );

  app.post(
    '/auth/change-password',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: LOGIN_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
            newPassword: passwordField,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { currentPassword: string; newPassword: string };
      const user = await changePassword({
        userId: authenticatedUserId(request.authUser?.sub),
        ...body,
      });
      // A fresh session for the caller, because the tokenVersion bump just
      // invalidated the refresh cookie they arrived with.
      return reply.status(200).send(await issueSession(user, config, reply));
    },
  );

  app.post(
    '/auth/google',
    {
      config: { rateLimit: REDEEM_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['code', 'codeVerifier', 'redirectUri'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 2048 },
            // RFC 7636 fixes the verifier at 43–128 characters. Bounding it here
            // means a malformed handshake is a 400 rather than a round trip to
            // Google that fails opaquely.
            codeVerifier: { type: 'string', minLength: 43, maxLength: 128 },
            redirectUri: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { code: string; codeVerifier: string; redirectUri: string };
      // The client secret is used inside here and never leaves the API.
      const identity = await verifyGoogleCode(body, config);
      const user = await findOrCreateGoogleUser(identity);
      return reply.status(200).send(await issueSession(user, config, reply));
    },
  );

  app.post(
    '/auth/logout',
    {
      onRequest: [app.authenticate],
      // Logout reads no cookie but does write one (clearing it), and it changes
      // server state, so the same guard applies.
      preHandler: [async (request) => requireCsrfHeader(request)],
    },
    async (request, reply) => {
      // Both halves matter. Clearing the cookie ends this browser's session;
      // bumping tokenVersion ends every other one, including any copy of the
      // cookie taken earlier. Without the bump, "sign out" only means "forget".
      await signOutEverywhere(authenticatedUserId(request.authUser?.sub));
      clearRefreshCookie(reply);
      return reply.status(204).send();
    },
  );

  app.get('/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = await User.findById(authenticatedUserId(request.authUser?.sub));
    if (!user) {
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }
    return reply.send({ user: toUserView(user) });
  });

  app.patch(
    '/me',
    {
      onRequest: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            // Nullable so a name can be cleared, not only changed. Without that
            // the only way back to "no name" would be a blank string, which
            // would then render as an empty greeting.
            name: { type: ['string', 'null'], maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name?: string | null };
      const user = await User.findById(authenticatedUserId(request.authUser?.sub));
      if (!user) {
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
      if (body.name !== undefined) {
        const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
        user.name = trimmed === '' ? null : trimmed;
      }
      await user.save();
      return reply.send({ user: toUserView(user) });
    },
  );
};

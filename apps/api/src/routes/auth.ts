/**
 * Auth routes (doc 08 §2): login, refresh, logout, me.
 *
 * V1 login is a dev-mode credential exchange — find-or-create the user by
 * email and issue a token pair. OAuth providers slot in behind the same
 * endpoint later (doc 06); tokens and authorization are production-shaped.
 */

import type { FastifyPluginAsync } from 'fastify';
import { AppError, unwrap } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { User } from '@instantmockapi/db';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  type AuthUser,
} from '@instantmockapi/auth';
import { toUserView } from '../serializers.js';
import { isObjectIdHex } from '../access.js';

export interface AuthRouteOptions {
  config: EnvConfig;
}

const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';

async function issueTokenPair(user: AuthUser, config: EnvConfig) {
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(user, config),
    issueRefreshToken(user, config),
  ]);
  return { accessToken, refreshToken, expiresIn: config.jwtExpiresIn };
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, { config }) => {
  app.post(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
            authProvider: { type: 'string', enum: ['google', 'email'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; authProvider?: 'google' | 'email' };
      const email = body.email.toLowerCase();
      const user = await User.findOneAndUpdate(
        { email },
        { $setOnInsert: { email, authProvider: body.authProvider ?? 'email' } },
        { upsert: true, new: true },
      );
      const tokens = await issueTokenPair(
        { id: String(user._id), email: user.email, plan: user.plan },
        config,
      );
      return reply.status(200).send({ ...tokens, user: toUserView(user) });
    },
  );

  app.post(
    '/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          additionalProperties: false,
          properties: { refreshToken: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      const claims = unwrap(await verifyRefreshToken(refreshToken, config));
      if (!isObjectIdHex(claims.sub)) {
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
      const user = await User.findById(claims.sub);
      if (!user) {
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
      // Rotation: every refresh yields a fresh pair
      const tokens = await issueTokenPair(
        { id: String(user._id), email: user.email, plan: user.plan },
        config,
      );
      return reply.status(200).send({ ...tokens, user: toUserView(user) });
    },
  );

  app.post('/auth/logout', { onRequest: [app.authenticate] }, async (_request, reply) => {
    // Stateless JWTs: the client discards its tokens. A server-side refresh
    // denylist is a tracked follow-up (doc 13 §10).
    return reply.status(204).send();
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const sub = request.authUser?.sub ?? '';
    if (!isObjectIdHex(sub)) {
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }
    const user = await User.findById(sub);
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
      const sub = request.authUser?.sub ?? '';
      if (!isObjectIdHex(sub)) {
        throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
      const body = request.body as { name?: string | null };
      const user = await User.findById(sub);
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

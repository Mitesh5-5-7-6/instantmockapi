/**
 * Fastify auth plugin shared by `apps/api` and `apps/mock-runtime` (doc 13 §1).
 *
 * Decorates the instance with `app.authenticate`, an onRequest handler that
 * verifies the bearer token and attaches the claims as `request.authUser`.
 * Verification failures throw AppError(UNAUTHORIZED), which the app's error
 * handler serializes into the uniform envelope.
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { extractBearerToken, verifyAccessToken, type AuthTokenClaims } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Verified token claims; null until `authenticate` has run. */
    authUser: AuthTokenClaims | null;
  }
  interface FastifyInstance {
    /** onRequest handler enforcing `Authorization: Bearer <jwt>`. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  /** Env config override (tests inject a fixed secret); defaults to `loadEnvConfig()`. */
  config?: EnvConfig;
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const config = opts.config ?? loadEnvConfig();

  fastify.decorateRequest('authUser', null);

  fastify.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token.ok) {
      throw token.error;
    }
    const claims = await verifyAccessToken(token.value, config);
    if (!claims.ok) {
      throw claims.error;
    }
    request.authUser = claims.value;
  });
};

export const authPlugin = fp(plugin, {
  name: '@instantmockapi/auth',
  fastify: '5.x',
});

/**
 * Platform API server assembly (doc 08).
 *
 * buildServer() returns an un-listened Fastify instance so tests can drive it
 * via inject(); index.ts connects the DB and listens.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { loadEnvConfig, assertProductionSecrets, type EnvConfig } from '@instantmockapi/config';
import { authPlugin } from '@instantmockapi/auth';
import { createStorage, type StorageClient } from '@instantmockapi/storage';
import { registerErrorHandling } from './error-handler.js';
import { CSRF_HEADER } from './auth-cookies.js';
import type { Mailer } from './email.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { generationRoutes } from './routes/generation.js';
import { draftRoutes } from './routes/drafts.js';
import { jobRoutes } from './routes/jobs.js';
import { artifactRoutes } from './routes/artifacts.js';
import { versionRoutes } from './routes/versions.js';
import { dashboardRoutes } from './routes/dashboard.js';

export interface BuildServerOptions {
  /** Env config override; defaults to loadEnvConfig(). */
  config?: EnvConfig;
  /** Override the per-user rate limit, or `false` to disable (tests). */
  rateLimit?: { max?: number; timeWindowMs?: number } | false;
  /** SSE stream tuning (tests shrink the poll interval). */
  sse?: { pollIntervalMs?: number; maxDurationMs?: number };
  /** Object storage for artifact downloads; defaults to S3 from env config. */
  storage?: StorageClient;
  /** Email transport; defaults to Resend, or the log transport with no API key. */
  mailer?: Mailer;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadEnvConfig();

  // Before anything is constructed, and here rather than in an entrypoint: there
  // are two of those (node and the Vercel function) and this is the one path
  // both take. A no-op outside production.
  assertProductionSecrets(config);

  const storage = options.storage ?? createStorage(config);

  const app = Fastify({
    logger: false,
    bodyLimit: config.maxRequestBodySize,
    /**
     * Trust exactly one reverse proxy, so `request.ip` is the caller rather than
     * the load balancer.
     *
     * This is load-bearing, not hygiene. The rate limiter keys on
     * `request.authUser?.sub ?? request.ip`, and the credential routes that do
     * not name an email — signup, and the token-redemption routes — fall through
     * to the IP. Without this, every caller behind the platform's load balancer
     * shares one address, so `SIGNUP_LIMIT` (5/hour) becomes five signups an hour
     * *for the whole platform* and the sixth person of the hour gets a 429.
     *
     * `1`, not `true`: `true` trusts the entire `X-Forwarded-For` chain, which
     * lets a caller pick their own bucket by prepending an entry. `1` reads the
     * single hop the proxy actually appended and ignores anything before it.
     */
    trustProxy: 1,
  });

  registerErrorHandling(app);

  // The web app is a separate origin (doc 05: web talks HTTP only). Dev
  // defaults to the local web port; production sets WEB_ORIGIN explicitly.
  //
  // `credentials` is what lets the browser send the httpOnly refresh cookie to
  // /v1/auth. It also means `origin` may never become '*' — a browser rejects a
  // wildcard outright once credentials are involved, so the exact-origin config
  // above is load-bearing rather than merely tidy.
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // Listed explicitly rather than reflecting whatever is requested.
    // `x-requested-with` is the CSRF guard (see auth-cookies.ts): it must be
    // allowed here, because the preflight that CORS performs on account of this
    // header is exactly what makes the guard work.
    allowedHeaders: ['authorization', 'content-type', CSRF_HEADER],
  });

  // Parses `request.cookies` and provides reply.setCookie/clearCookie. Only the
  // /v1/auth routes use it; hand-rolled cookie serialisation is a well-known
  // source of subtle attribute bugs.
  await app.register(cookie);

  await app.register(authPlugin, { config });

  if (options.rateLimit !== false) {
    await app.register(rateLimit, {
      max: options.rateLimit?.max ?? config.rateLimitPerMinute,
      timeWindow: options.rateLimit?.timeWindowMs ?? 60_000,
      // preHandler, not the plugin's default onRequest, for two reasons:
      // `request.authUser` is only populated by the `authenticate` onRequest
      // hook, and the credential routes key their own limits on the submitted
      // email, which does not exist until the body is parsed.
      hook: 'preHandler',
      // Per-user token bucket (doc 08 §8), keyed on the *verified* user id.
      //
      // Keying on the raw Authorization header (as this once did) is a bypass:
      // an unauthenticated client can send a different garbage token on every
      // request and get a fresh bucket each time. `authUser` is null unless a
      // signature actually verified, so a forged header falls back to the IP.
      keyGenerator: (request) => request.authUser?.sub ?? request.ip,
      // The plugin's 429 error flows through the shared error handler, which
      // shapes it into the RATE_LIMIT_EXCEEDED envelope.
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(authRoutes, { prefix: '/v1', config, mailer: options.mailer });
  await app.register(projectRoutes, { prefix: '/v1', config });
  await app.register(generationRoutes, { prefix: '/v1', config });
  await app.register(draftRoutes, { prefix: '/v1', config });
  await app.register(jobRoutes, {
    prefix: '/v1',
    config,
    sse: { maxDurationMs: 25_000, pollIntervalMs: 2000 },
  });
  await app.register(artifactRoutes, { prefix: '/v1', config, storage });
  await app.register(versionRoutes, { prefix: '/v1', config });
  await app.register(dashboardRoutes, { prefix: '/v1', config });

  return app;
}

/**
 * Platform API server assembly (doc 08).
 *
 * buildServer() returns an un-listened Fastify instance so tests can drive it
 * via inject(); index.ts connects the DB and listens.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { authPlugin } from '@instantmockapi/auth';
import { registerErrorHandling } from './error-handler.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { generationRoutes } from './routes/generation.js';
import { jobRoutes } from './routes/jobs.js';
import { artifactRoutes } from './routes/artifacts.js';
import { versionRoutes } from './routes/versions.js';

export interface BuildServerOptions {
  /** Env config override; defaults to loadEnvConfig(). */
  config?: EnvConfig;
  /** Override the per-user rate limit, or `false` to disable (tests). */
  rateLimit?: { max?: number; timeWindowMs?: number } | false;
  /** SSE stream tuning (tests shrink the poll interval). */
  sse?: { pollIntervalMs?: number; maxDurationMs?: number };
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadEnvConfig();

  const app = Fastify({
    logger: false,
    bodyLimit: config.maxRequestBodySize,
  });

  registerErrorHandling(app);
  await app.register(authPlugin, { config });

  if (options.rateLimit !== false) {
    await app.register(rateLimit, {
      max: options.rateLimit?.max ?? config.rateLimitPerMinute,
      timeWindow: options.rateLimit?.timeWindowMs ?? 60_000,
      // Per-user token bucket (doc 08 §8): the bearer token identifies the
      // user; unauthenticated requests fall back to the client IP.
      // The plugin's 429 error flows through the shared error handler, which
      // shapes it into the RATE_LIMIT_EXCEEDED envelope.
      keyGenerator: (request) => request.headers.authorization ?? request.ip,
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(authRoutes, { prefix: '/v1', config });
  await app.register(projectRoutes, { prefix: '/v1', config });
  await app.register(generationRoutes, { prefix: '/v1', config });
  await app.register(jobRoutes, { prefix: '/v1', config, sse: options.sse });
  await app.register(artifactRoutes, { prefix: '/v1', config });
  await app.register(versionRoutes, { prefix: '/v1', config });

  return app;
}

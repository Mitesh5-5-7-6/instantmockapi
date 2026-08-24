/**
 * Hosted Mock API server assembly (doc 08 §9, doc 13 §4–5).
 * buildMockRuntime() returns an un-listened Fastify instance for tests;
 * index.ts connects infrastructure and listens.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { getErrorMessage, logger, AppError, OBJECT_ID_PATTERN } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { StorageClient } from '@instantmockapi/storage';
import type { CacheService } from './cache.js';
import { lookupPublicId } from './identity.js';
import { firstHostedSegment } from './path.js';
import { registerHostedRoutes } from './routes.js';

export interface BuildRuntimeOptions {
  config?: EnvConfig;
  storage: StorageClient;
  cache: CacheService;
  /** Override the per-project rate limit, or `false` to disable (tests). */
  rateLimit?: { max?: number; timeWindowMs?: number } | false;
}

export async function buildMockRuntime(options: BuildRuntimeOptions): Promise<FastifyInstance> {
  const config = options.config ?? loadEnvConfig();

  const app = Fastify({
    logger: false,
    // Payload caps stop memory-exhaustion via giant writes (doc 13 §4)
    bodyLimit: config.maxRequestBodySize,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      logger.error('Mock runtime error', {
        error: getErrorMessage(error),
        method: request.method,
        url: request.url,
      });
    }
    void reply.status(status).send({
      error: {
        code:
          status === 429
            ? 'RATE_LIMIT_EXCEEDED'
            : status < 500
              ? 'VALIDATION_ERROR'
              : 'INTERNAL_ERROR',
        message: status >= 500 ? 'Internal server error' : getErrorMessage(error),
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  // The hosted mock API is public and browser-facing — the web playground and
  // any consumer app call it cross-origin. It carries no cookies/credentials,
  // so reflect any origin. (Rate limiting below still bounds abuse.)
  await app.register(cors, { origin: true });

  if (options.rateLimit !== false) {
    // Per-PROJECT rate limit (doc 13 §5): a public mock URL must not become
    // a free unbounded traffic sink.
    //
    // Both URL forms must land in the SAME bucket, or a caller could double its
    // allowance by alternating them. The key generator has to stay synchronous,
    // so a pretty URL is canonicalised through the process-local index the
    // resolver populates; a cold process keys on the raw public id for its first
    // request, which is the only imprecision. `proj:`/`ip:` are namespaced so a
    // project id can never collide with an IP.
    await app.register(rateLimit, {
      max: options.rateLimit?.max ?? config.mockRateLimitPerMinute,
      timeWindow: options.rateLimit?.timeWindowMs ?? 60_000,
      keyGenerator: (request) => {
        const first = firstHostedSegment(request.raw.url ?? request.url);
        if (!first) {
          return `ip:${request.ip}`;
        }
        if (OBJECT_ID_PATTERN.test(first)) {
          return `proj:${first.toLowerCase()}`;
        }
        return `proj:${lookupPublicId(first) ?? first}`;
      },
    });
  }

  // Cache counters ride along on the health check so Redis command usage is
  // observable per replica without adding a second endpoint. Counters only —
  // no keys or cached values are exposed.
  app.get('/healthz', async () => ({ status: 'ok', cache: options.cache.stats() }));

  registerHostedRoutes(app, {
    storage: options.storage,
    cache: options.cache,
    config,
  });

  return app;
}

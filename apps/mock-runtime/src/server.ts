/**
 * Hosted Mock API server assembly (doc 08 §9, doc 13 §4–5).
 * buildMockRuntime() returns an un-listened Fastify instance for tests;
 * index.ts connects infrastructure and listens.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { getErrorMessage, logger, AppError } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { StorageClient } from '@instantmockapi/storage';
import type { CacheClient } from './cache.js';
import { registerHostedRoutes } from './routes.js';

export interface BuildRuntimeOptions {
  config?: EnvConfig;
  storage: StorageClient;
  cache: CacheClient;
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

  if (options.rateLimit !== false) {
    // Per-PROJECT rate limit (doc 13 §5): a public mock URL must not become
    // a free unbounded traffic sink.
    await app.register(rateLimit, {
      max: options.rateLimit?.max ?? config.mockRateLimitPerMinute,
      timeWindow: options.rateLimit?.timeWindowMs ?? 60_000,
      keyGenerator: (request) => {
        const params = request.params as { projectId?: string } | undefined;
        return params?.projectId ?? request.ip;
      },
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  registerHostedRoutes(app, {
    storage: options.storage,
    cache: options.cache,
    config,
  });

  return app;
}

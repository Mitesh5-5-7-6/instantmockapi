/**
 * Hosted Mock API server assembly (doc 08 §9, doc 13 §4–5).
 * buildMockRuntime() returns an un-listened Fastify instance for tests;
 * index.ts connects infrastructure and listens.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  createRequestObserver,
  getErrorMessage,
  logger,
  AppError,
  HTTP_METHODS,
  OBJECT_ID_PATTERN,
} from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { StorageClient } from '@instantmockapi/storage';
import type { CacheService } from './cache.js';
import { lookupPublicId } from './identity.js';
import { firstHostedSegment } from './path.js';
import { registerHostedRoutes } from './routes.js';
import { authAttemptKey } from './auth/rate-limit.js';

export interface BuildRuntimeOptions {
  config?: EnvConfig;
  storage: StorageClient;
  cache: CacheService;
  /**
   * Override the rate limits, or `false` to disable both (tests).
   *
   * `authMax` is the separate, much tighter credential budget — see the
   * registration below and `auth/rate-limit.ts`.
   */
  rateLimit?: { max?: number; timeWindowMs?: number; authMax?: number } | false;
}

export async function buildMockRuntime(options: BuildRuntimeOptions): Promise<FastifyInstance> {
  const config = options.config ?? loadEnvConfig();

  const app = Fastify({
    logger: false,
    // Payload caps stop memory-exhaustion via giant writes (doc 13 §4)
    bodyLimit: config.maxRequestBodySize,
    /**
     * Trust exactly one reverse proxy, so `request.ip` is the caller rather than
     * the load balancer.
     *
     * Needed here for two reasons: the per-project rate limit keys on the client
     * address, and the request log records it — a hosted mock URL is public and
     * unauthenticated, so "who is calling this" is a question the owner can
     * reasonably ask, and a column full of one proxy address answers nothing.
     *
     * `1`, not `true`: `true` trusts the whole `X-Forwarded-For` chain, letting a
     * caller choose the address that gets recorded and rate-limited.
     */
    trustProxy: 1,
  });

  /**
   * One structured line per request (Phase 6 §12).
   *
   * The same hook the management API registers, and it matters more here: a
   * hosted mock URL is what a developer's own application calls, so cold-start
   * latency shows up in *their* app as an intermittently slow dependency. Being
   * able to say "that one was a wake-up, the rest were 8ms" is the difference
   * between a known platform characteristic and an unexplained fault.
   *
   * `service: 'mock-runtime'` so one log stream can carry both apps. The route
   * pattern rather than the path keeps public-id and slug values out of the log
   * and keeps per-endpoint counts groupable.
   */
  const observeRequest = createRequestObserver({ service: 'mock-runtime' });
  app.addHook('onResponse', (request, reply, done) => {
    observeRequest({
      method: request.method,
      route: request.routeOptions.url ?? '(unrouted)',
      status: reply.statusCode,
      requestId: request.id,
      durationMs: reply.elapsedTime,
    });
    done();
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
  //
  // `methods` is NOT optional here. @fastify/cors defaults to 'GET,HEAD,POST',
  // so omitting it makes the preflight for PUT, PATCH and DELETE answer 204
  // while advertising only those three — the browser then blocks the real
  // request with an opaque CORS error, and every write method is unusable from
  // a browser. curl is unaffected, which is exactly why this hid for so long.
  //
  // Taken from HTTP_METHODS, the same list the wildcard route is registered
  // with, so CORS cannot advertise less than the runtime actually serves.
  await app.register(cors, { origin: true, methods: [...HTTP_METHODS] });

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
    const projectMax = options.rateLimit?.max ?? config.mockRateLimitPerMinute;
    const authMax = options.rateLimit?.authMax ?? config.mockAuthRateLimitPerMinute;

    await app.register(rateLimit, {
      /*
       * Two ceilings on one limiter (Phase 3 §23).
       *
       * The credential endpoints get their own namespaced key — per caller IP
       * per project — and a much lower max. Sharing the project bucket would
       * allow 200 password guesses a minute AND spend a legitimate caller's
       * allowance doing it, so the defence would itself be the denial of
       * service. See `auth/rate-limit.ts`.
       *
       * `max` and `keyGenerator` both parse the URL rather than sharing state
       * through the request. It is pure string work on a path already in
       * memory, and a stashed value would be a second source of truth for
       * which bucket a request belongs to.
       */
      max: (request) =>
        authAttemptKey(request.raw.url ?? request.url, request.ip, lookupPublicId) === null
          ? projectMax
          : authMax,
      timeWindow: options.rateLimit?.timeWindowMs ?? 60_000,
      keyGenerator: (request) => {
        const url = request.raw.url ?? request.url;
        const credential = authAttemptKey(url, request.ip, lookupPublicId);
        if (credential !== null) {
          return credential;
        }
        const first = firstHostedSegment(url);
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
  app.get('/health/live', async () => ({ status: 'ok', cache: options.cache.stats() }));

  registerHostedRoutes(app, {
    storage: options.storage,
    cache: options.cache,
    config,
  });

  return app;
}

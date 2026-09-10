/**
 * Platform API server assembly (doc 08).
 *
 * buildServer() returns an un-listened Fastify instance so tests can drive it
 * via inject(); index.ts connects the DB and listens.
 */

import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { REQUEST_ID_PATTERN, createRequestObserver } from '@instantmockapi/shared';
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
import { technicalNotesRoutes } from './routes/technical-notes.js';
import { blueprintRoutes } from './routes/blueprint.js';
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
    /**
     * A correlation id per request, echoed to the caller and quoted in the error
     * envelope so a user reporting "it failed" can hand over something findable.
     *
     * Fastify's default is a per-process counter — `req-1`, `req-2` — which
     * restarts at 1 on every deploy and collides across instances, so two
     * unrelated failures a week apart can carry the same id. Random hex, in the
     * same `prefix_lowercasehex` grammar as `prj_`/`sng_`/`ent_`, is unique
     * enough to search a log for.
     *
     * An inbound `x-request-id` is honoured when it looks like an id we minted,
     * so a request traced through another service keeps one id end to end. It is
     * validated rather than trusted: an unvalidated header is a log-injection
     * vector and a way to make two different requests share an id.
     */
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      if (typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound)) {
        return inbound;
      }
      return `req_${randomBytes(5).toString('hex')}`;
    },
  });

  /**
   * Every response carries its id, not only failures.
   *
   * A caller debugging a wrong-looking 200 needs the same handle as one
   * debugging a 500, and a body-only id is unreadable when the body is not ours
   * — a gateway 502, an HTML error page, a 413 from the proxy. The header is the
   * one place the id survives all of those.
   */
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  /**
   * One structured line per request (Phase 6 §12).
   *
   * `logger: false` above is deliberate — Fastify's own logger is pino, and the
   * platform already has a structured logger whose output every other component
   * emits. Two log formats in one stream is worse than one, so the hook feeds
   * `packages/shared`'s logger instead.
   *
   * The field that matters is `coldStart`. Cold-start latency and a slow query
   * look identical from outside, and no measurement of a single request can
   * tell them apart — only "had this instance served anything yet" can.
   *
   * `reply.elapsedTime` is Fastify's own measurement, so nothing here times
   * anything by hand. `routeOptions.url` is the *pattern*: a concrete path would
   * put project ids in the log and fragment the per-endpoint view. The fallback
   * is a literal, not `request.url`, so a 404 on an unrouted path cannot smuggle
   * a caller-controlled string into the log.
   */
  const observeRequest = createRequestObserver({ service: 'api' });
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

  /**
   * Liveness, plus **which build is answering**.
   *
   * `status: 'ok'` alone made a recurring question unanswerable: a request that
   * fails because the deployed code predates the fix is indistinguishable from
   * one that fails because the request is wrong. Both times it came up — a
   * route that existed locally and 404'd in the browser, and an enum value that
   * validated locally and 400'd against the deployment — the answer took a
   * round trip to find out, and neither could be settled from the client at all.
   *
   * `RENDER_GIT_COMMIT` and `RENDER_GIT_BRANCH` are set by the platform, so
   * this needs no build step and no generated file. Absent locally, where the
   * question does not arise.
   *
   * A commit SHA of a private repository discloses nothing usable — it is not a
   * credential and cannot be exchanged for source. The alternative, keeping it
   * behind auth, would put it out of reach of exactly the debugging session that
   * needs it.
   */
  const startedAt = new Date().toISOString();
  app.get('/healthz', async () => ({
    status: 'ok',
    commit: process.env['RENDER_GIT_COMMIT'] ?? null,
    branch: process.env['RENDER_GIT_BRANCH'] ?? null,
    // Distinguishes "deployed but not restarted" from "never deployed", which
    // the SHA alone cannot.
    startedAt,
  }));

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
  await app.register(technicalNotesRoutes, { prefix: '/v1', config });
  await app.register(blueprintRoutes, { prefix: '/v1', config });
  await app.register(dashboardRoutes, { prefix: '/v1', config });

  return app;
}

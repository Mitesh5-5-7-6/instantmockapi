/**
 * Hosted CRUD endpoints (doc 08 §9, doc 19 §Phase 3).
 *
 * Two URL shapes resolve — the original `/p/{projectId}/{entity}` and the
 * advertised `/p/{publicId}/{slug}/{entity}`. Fastify cannot register
 * `/p/:a/:b/:c` twice, so a single wildcard route dispatches through the pure
 * parser in `path.ts`; nothing about the grammar lives in the registration.
 *
 * Only user-selected methods are routed — everything else answers 405.
 * Writes are validated by the safe interpreter (422 with field errors).
 * Every request is logged to apiLogs (TTL-retained, doc 13 §9).
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, HTTP_METHODS, hostedUrl, type HttpMethod } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { ApiLog } from '@instantmockapi/db';
import type { StorageClient } from '@instantmockapi/storage';
import type { HostedEntityConfig } from '@instantmockapi/generator-hosting';
import type { CacheService } from './cache.js';
import { notFound, resolveHostedProject, type HostedContext } from './hosting.js';
import { parseHostedPath, refPath, type HostedRefInput, type HostedTarget } from './path.js';
import {
  DEFAULT_IDENTITY_RULE,
  findRecordIndex,
  readRecords,
  recordId,
  writeRecords,
  type IdentityRule,
  type MockRecord,
} from './store.js';
import { validateRecord } from './validate.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Canonical project the request resolved to. Set by the dispatcher and read
     * by the apiLogs hook, which needs the ObjectId — a pretty URL carries only
     * the public id, and `ApiLog.projectId` is an ObjectId ref.
     */
    hosted: { projectId: string } | null;
  }
}

export interface RuntimeDeps {
  storage: StorageClient;
  cache: CacheService;
  config?: EnvConfig;
}

function methodNotAllowed(entity: HostedEntityConfig): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    statusCode: 405,
    message: `Method not enabled for this entity. Enabled: ${entity.methods.join(', ') || 'none'}`,
  });
}

function invalidWrite(details: { path: string; issue: string }[]): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message: 'Record failed validation against the generated rules',
    details,
  });
}

/**
 * Identity descriptor of a hosted entity.
 *
 * Configs generated before identity descriptors existed carry none, and must keep
 * routing on `id` with the `rec-<n>` fallback.
 */
function identityOf(entity: HostedEntityConfig): IdentityRule {
  return entity.identity ?? DEFAULT_IDENTITY_RULE;
}

/** Discovery document served at the project's base URL. */
function sendIndex(reply: FastifyReply, ctx: HostedContext, env: EnvConfig): FastifyReply {
  const base = hostedUrl(env.hostedBaseUrl, ctx);
  return reply.send({
    data: {
      kind: ctx.kind,
      version: ctx.version,
      canonicalUrl: base,
      entities: [...ctx.entities.values()].map((entity) => ({
        name: entity.name,
        path: entity.path,
        methods: entity.methods,
        url: `${base}/${entity.path}`,
      })),
    },
  });
}

export function registerHostedRoutes(app: FastifyInstance, deps: RuntimeDeps): void {
  const env = deps.config ?? loadEnvConfig();

  app.decorateRequest('hosted', null);

  // Request logging → apiLogs (fire-and-forget; never blocks the response).
  // Reads the decorator rather than a route param: params are a function of the
  // route shape, so a reshape would silently turn this hook into a no-op with no
  // failing test. Requests that 404 before resolution log nothing, as before.
  app.addHook('onResponse', (request, reply, done) => {
    const hosted = request.hosted;
    if (hosted) {
      ApiLog.create({
        projectId: hosted.projectId,
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        at: new Date(),
      }).catch(() => undefined);
    }
    done();
  });

  // GET list — paginated from the seed store (doc 08 §9)
  const listRecords = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
  ): Promise<FastifyReply> => {
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(
      Math.max(1, Number.parseInt(query.limit ?? '20', 10) || 20),
      env.maxPaginationLimit,
    );

    const identity = identityOf(entity);
    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const start = (page - 1) * limit;
    const data = records.slice(start, start + limit).map((record, index) => ({
      [identity.field]: recordId(record, start + index, identity),
      ...record,
    }));

    return reply.send({ data, meta: { page, limit, total: records.length } });
  };

  // GET one
  const getRecord = async (
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
    id: string,
  ): Promise<FastifyReply> => {
    const identity = identityOf(entity);
    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const index = findRecordIndex(records, id, identity);
    if (index === -1) {
      throw notFound('Record not found');
    }
    return reply.send({ [identity.field]: id, ...records[index] });
  };

  // POST create — validated against the generated rules
  const createRecord = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
  ): Promise<FastifyReply> => {
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body);
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const records = await readRecords(ctx, entity.path, deps.cache, env);
    if (records.length >= env.maxMockRecords) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: `Record store is full (max ${env.maxMockRecords} records per entity)`,
      });
    }

    const identity = identityOf(entity);
    const record: MockRecord = { ...body };
    const supplied = record[identity.field];
    // Runtime-created records always get a UUID, even for int-style entities, so
    // seeded `/students/1` and created `/students/<uuid>` coexist without a
    // counter the store would have to keep.
    if (typeof supplied !== 'number' && (typeof supplied !== 'string' || supplied === '')) {
      record[identity.field] = randomUUID();
    } else if (findRecordIndex(records, String(supplied), identity) !== -1) {
      throw new AppError({
        code: 'CONFLICT',
        message: `A record with ${identity.field} '${String(supplied)}' already exists`,
      });
    }

    await writeRecords(ctx, entity.path, [...records, record], deps.cache, env);
    return reply.status(201).send(record);
  };

  // PUT replace — full validation
  const replaceRecord = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
    id: string,
  ): Promise<FastifyReply> => {
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body);
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const identity = identityOf(entity);
    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const index = findRecordIndex(records, id, identity);
    if (index === -1) {
      throw notFound('Record not found');
    }

    const replaced: MockRecord = { ...body, [identity.field]: id };
    const next = [...records];
    next[index] = replaced;
    await writeRecords(ctx, entity.path, next, deps.cache, env);
    return reply.send(replaced);
  };

  // PATCH update — merge, then validate the provided fields
  const patchRecord = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
    id: string,
  ): Promise<FastifyReply> => {
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body, { partial: true });
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const identity = identityOf(entity);
    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const index = findRecordIndex(records, id, identity);
    if (index === -1) {
      throw notFound('Record not found');
    }

    const merged: MockRecord = { ...records[index], ...body, [identity.field]: id };
    const next = [...records];
    next[index] = merged;
    await writeRecords(ctx, entity.path, next, deps.cache, env);
    return reply.send(merged);
  };

  // DELETE remove
  const deleteRecord = async (
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
    id: string,
  ): Promise<FastifyReply> => {
    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const index = findRecordIndex(records, id, identityOf(entity));
    if (index === -1) {
      throw notFound('Record not found');
    }
    await writeRecords(
      ctx,
      entity.path,
      records.filter((_, i) => i !== index),
      deps.cache,
      env,
    );
    return reply.status(204).send();
  };

  /** Wrong-URL-shape 405s, worded with the caller's own URL form. */
  const requiresRecordId = (ref: HostedRefInput): AppError =>
    new AppError({
      code: 'VALIDATION_ERROR',
      statusCode: 405,
      message: `This method requires a record id: ${refPath(ref)}/{entity}/{recordId}`,
    });

  const postsOnCollection = (ref: HostedRefInput): AppError =>
    new AppError({
      code: 'VALIDATION_ERROR',
      statusCode: 405,
      message: `POST creates records on the collection URL: ${refPath(ref)}/{entity}`,
    });

  const dispatch = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const target: HostedTarget | null = parseHostedPath(request.raw.url ?? request.url);
    if (!target) {
      throw notFound();
    }

    const ctx = await resolveHostedProject(target.ref, deps);
    request.hosted = { projectId: ctx.projectId };

    if (target.kind === 'index') {
      return sendIndex(reply, ctx, env);
    }

    const entity = ctx.entities.get(target.entity.toLowerCase());
    if (!entity) {
      throw notFound('Entity not found');
    }
    const method = request.method as HttpMethod;
    // Unselected-method 405 wins over the wrong-shape 405, as it always has.
    if (!entity.methods.includes(method)) {
      void reply.header('allow', entity.methods.join(', '));
      throw methodNotAllowed(entity);
    }

    if (target.kind === 'collection') {
      switch (method) {
        case 'GET':
          return listRecords(request, reply, ctx, entity);
        case 'POST':
          return createRecord(request, reply, ctx, entity);
        default:
          throw requiresRecordId(target.ref);
      }
    }

    switch (method) {
      case 'GET':
        return getRecord(reply, ctx, entity, target.recordId);
      case 'PUT':
        return replaceRecord(request, reply, ctx, entity, target.recordId);
      case 'PATCH':
        return patchRecord(request, reply, ctx, entity, target.recordId);
      case 'DELETE':
        return deleteRecord(reply, ctx, entity, target.recordId);
      default:
        throw postsOnCollection(target.ref);
    }
  };

  // One wildcard route for the whole hosted surface: the grammar lives in
  // `parseHostedPath`, not in the registration, because Fastify cannot express
  // "either 2 or 3 segments, meaning different things depending on the first".
  app.route({ method: [...HTTP_METHODS], url: '/p/*', handler: dispatch });
  app.route({ method: [...HTTP_METHODS], url: '/p', handler: dispatch });
}

export function sendErrorEnvelope(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send(error.toJSON());
  }
  return reply
    .status(500)
    .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

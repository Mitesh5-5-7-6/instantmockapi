/**
 * Hosted CRUD endpoints (doc 08 §9): /p/{projectId}/{entity}[/{recordId}].
 *
 * Only user-selected methods are routed — everything else answers 405.
 * Writes are validated by the safe interpreter (422 with field errors).
 * Every request is logged to apiLogs (TTL-retained, doc 13 §9).
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type HttpMethod } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { ApiLog } from '@instantmockapi/db';
import type { StorageClient } from '@instantmockapi/storage';
import type { HostedEntityConfig } from '@instantmockapi/generator-hosting';
import type { CacheClient } from './cache.js';
import { notFound, resolveHostedProject, type HostedContext } from './hosting.js';
import { findRecordIndex, readRecords, recordId, writeRecords, type MockRecord } from './store.js';
import { validateRecord } from './validate.js';

export interface RuntimeDeps {
  storage: StorageClient;
  cache: CacheClient;
  config?: EnvConfig;
}

interface EntityParams {
  projectId: string;
  entity: string;
  recordId?: string;
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

async function resolveEntity(
  request: FastifyRequest,
  deps: RuntimeDeps,
): Promise<{ ctx: HostedContext; entity: HostedEntityConfig }> {
  const { projectId, entity: entityPath } = request.params as EntityParams;
  const ctx = await resolveHostedProject(projectId, deps);
  const entity = ctx.entities.get(entityPath.toLowerCase());
  if (!entity) {
    throw notFound('Entity not found');
  }
  const method = request.method as HttpMethod;
  if (!entity.methods.includes(method)) {
    throw methodNotAllowed(entity);
  }
  return { ctx, entity };
}

export function registerHostedRoutes(app: FastifyInstance, deps: RuntimeDeps): void {
  const env = deps.config ?? loadEnvConfig();

  // Request logging → apiLogs (fire-and-forget; never blocks the response)
  app.addHook('onResponse', (request, reply, done) => {
    const { projectId } = request.params as Partial<EntityParams>;
    if (projectId && /^[0-9a-f]{24}$/i.test(projectId)) {
      ApiLog.create({
        projectId,
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        at: new Date(),
      }).catch(() => undefined);
    }
    done();
  });

  const collectionUrl = '/p/:projectId/:entity';
  const recordUrl = '/p/:projectId/:entity/:recordId';

  // GET list — paginated from the seed store (doc 08 §9)
  app.get(collectionUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(
      Math.max(1, Number.parseInt(query.limit ?? '20', 10) || 20),
      env.maxPaginationLimit,
    );

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    const start = (page - 1) * limit;
    const data = records
      .slice(start, start + limit)
      .map((record, index) => ({ id: recordId(record, start + index), ...record }));

    return reply.send({ data, meta: { page, limit, total: records.length } });
  });

  // GET one
  app.get(recordUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const { recordId: id } = request.params as Required<EntityParams>;

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    const index = findRecordIndex(records, id);
    if (index === -1) {
      throw notFound('Record not found');
    }
    return reply.send({ id, ...records[index] });
  });

  // POST create — validated against the generated rules
  app.post(collectionUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body);
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    if (records.length >= env.maxMockRecords) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: `Record store is full (max ${env.maxMockRecords} records per entity)`,
      });
    }

    const record: MockRecord = { ...body };
    if (typeof record['id'] !== 'string' || record['id'] === '') {
      record['id'] = randomUUID();
    } else if (findRecordIndex(records, String(record['id'])) !== -1) {
      throw new AppError({
        code: 'CONFLICT',
        message: `A record with id '${String(record['id'])}' already exists`,
      });
    }

    await writeRecords(ctx.projectId, entity.path, [...records, record], deps.cache);
    return reply.status(201).send(record);
  });

  // PUT replace — full validation
  app.put(recordUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const { recordId: id } = request.params as Required<EntityParams>;
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body);
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    const index = findRecordIndex(records, id);
    if (index === -1) {
      throw notFound('Record not found');
    }

    const replaced: MockRecord = { ...body, id };
    const next = [...records];
    next[index] = replaced;
    await writeRecords(ctx.projectId, entity.path, next, deps.cache);
    return reply.send(replaced);
  });

  // PATCH update — merge, then validate the provided fields
  app.patch(recordUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const { recordId: id } = request.params as Required<EntityParams>;
    const body = (request.body ?? {}) as MockRecord;

    const errors = validateRecord(entity.fields, body, { partial: true });
    if (errors.length > 0) {
      throw invalidWrite(errors);
    }

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    const index = findRecordIndex(records, id);
    if (index === -1) {
      throw notFound('Record not found');
    }

    const merged: MockRecord = { ...records[index], ...body, id };
    const next = [...records];
    next[index] = merged;
    await writeRecords(ctx.projectId, entity.path, next, deps.cache);
    return reply.send(merged);
  });

  // DELETE remove
  app.delete(recordUrl, async (request, reply) => {
    const { ctx, entity } = await resolveEntity(request, deps);
    const { recordId: id } = request.params as Required<EntityParams>;

    const records = await readRecords(ctx.projectId, entity.path, deps.cache);
    const index = findRecordIndex(records, id);
    if (index === -1) {
      throw notFound('Record not found');
    }
    await writeRecords(
      ctx.projectId,
      entity.path,
      records.filter((_, i) => i !== index),
      deps.cache,
    );
    return reply.status(204).send();
  });

  // Selected-method gate for verbs that have no handler above: Fastify would
  // answer 404 for e.g. DELETE on the collection URL — keep that behavior,
  // but PUT/PATCH/DELETE on collections and POST on records get explicit 405s.
  app.route({
    method: ['PUT', 'PATCH', 'DELETE'],
    url: collectionUrl,
    handler: async (request) => {
      await resolveEntity(request, deps); // throws 405 if method unselected, else:
      throw new AppError({
        code: 'VALIDATION_ERROR',
        statusCode: 405,
        message: 'This method requires a record id: /p/{projectId}/{entity}/{recordId}',
      });
    },
  });
  app.post(recordUrl, async (request) => {
    await resolveEntity(request, deps);
    throw new AppError({
      code: 'VALIDATION_ERROR',
      statusCode: 405,
      message: 'POST creates records on the collection URL: /p/{projectId}/{entity}',
    });
  });
}

export function sendErrorEnvelope(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send(error.toJSON());
  }
  return reply
    .status(500)
    .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

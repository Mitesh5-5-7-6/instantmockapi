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
import { ApiLog, USER_AGENT_MAX_LENGTH, type ApiLogShape } from '@instantmockapi/db';
import type { StorageClient } from '@instantmockapi/storage';
import { enabledQueryFeatures, type EntityQueryFields } from '@instantmockapi/ips';
import type { HostedEntityConfig } from '@instantmockapi/generator-hosting';
import type { CacheService } from './cache.js';
import { notFound, resolveHostedProject, type HostedContext } from './hosting.js';
import { parseHostedPath, refPath, type HostedRefInput, type HostedTarget } from './path.js';
import {
  NO_QUERY_FIELDS,
  expandIncludes,
  paginate,
  parseQuery,
  selectRecords,
  sortRecords,
  type IncludeTarget,
} from './query.js';
import {
  DEFAULT_IDENTITY_RULE,
  findRecordIndex,
  materializeIdentity,
  readRecords,
  writeRecords,
  type IdentityRule,
  type MockRecord,
} from './store.js';
import { validateRecord } from './validate.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * What the request resolved to. Set by the dispatcher, read by the apiLogs
     * hook.
     *
     * `projectId` because the hook needs the ObjectId and a pretty URL carries
     * only the public id. `entity` and `shape` because they are the grouping keys
     * for per-endpoint reporting, and the *only* place they can be captured is
     * here: the whole hosted surface is one wildcard route (`/p/*`), so
     * `request.routeOptions.url` is always `/p/*` and the grammar lives in
     * `parseHostedPath`. By the time this hook runs, that parse has already
     * happened — recording its result is free, re-deriving it later is not
     * possible.
     *
     * Both are null until an entity resolves, so a request that finds the project
     * but not the entity logs a row with a status and no endpoint attribution.
     */
    hosted: {
      projectId: string;
      entity: string | null;
      shape: ApiLogShape | null;
    } | null;
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

/**
 * Query-capable fields of a hosted entity.
 *
 * Configs generated before the query layer carry none, which resolves to "no
 * field is queryable" — combined with all-off features, such a project answers
 * exactly as it did before this existed.
 */
function queryFieldsOf(entity: HostedEntityConfig): EntityQueryFields {
  return entity.query ?? NO_QUERY_FIELDS;
}

/**
 * The relations named by `?include=`, in the order the caller asked for them.
 *
 * Unknown names never reach here: `parseQuery` validates them against the
 * includable list the config carries for this entity.
 */
function includeTargets(entity: HostedEntityConfig, names: readonly string[]): IncludeTarget[] {
  const targets: IncludeTarget[] = [];
  for (const name of names) {
    const relation = (entity.relations ?? []).find((candidate) => candidate.name === name);
    if (relation) {
      targets.push({
        name: relation.name,
        targetPath: relation.targetPath,
        localField: relation.localField,
        foreignField: relation.foreignField,
        collection: relation.collection,
      });
    }
  }
  return targets;
}

/**
 * The query capabilities an entity advertises, limited to enabled features.
 *
 * Omitted entirely when nothing is enabled, so a project generated before the
 * query layer keeps the exact discovery document it had.
 */
function describeQuery(
  entity: HostedEntityConfig,
  features: HostedContext['features'],
): { query?: Partial<EntityQueryFields> } {
  const fields = queryFieldsOf(entity);
  const query: Partial<EntityQueryFields> = {};
  if (features.search) {
    query.searchable = fields.searchable;
  }
  if (features.filter) {
    query.filterable = fields.filterable;
  }
  if (features.sort) {
    query.sortable = fields.sortable;
  }
  if (features.include) {
    query.includable = fields.includable;
  }
  return Object.keys(query).length > 0 ? { query } : {};
}

/** Discovery document served at the project's base URL. */
function sendIndex(reply: FastifyReply, ctx: HostedContext, env: EnvConfig): FastifyReply {
  const base = hostedUrl(env.hostedBaseUrl, ctx);
  return reply.send({
    data: {
      kind: ctx.kind,
      version: ctx.version,
      canonicalUrl: base,
      features: enabledQueryFeatures(ctx.features),
      entities: [...ctx.entities.values()].map((entity) => ({
        name: entity.name,
        path: entity.path,
        methods: entity.methods,
        url: `${base}/${entity.path}`,
        // Only the lists the caller can actually use, so the document answers
        // "what can I send?" rather than describing a capability that 400s.
        ...describeQuery(entity, ctx.features),
      })),
    },
  });
}

/**
 * Caller's user-agent, truncated, or null.
 *
 * Truncated at write time rather than left to the schema's `maxlength`: that
 * validator *rejects* an over-long value, and because the log write is
 * fire-and-forget with a swallowed rejection, a long user-agent would silently
 * drop the entire row instead of storing a shortened one.
 */
function userAgentOf(request: FastifyRequest): string | null {
  const raw = request.headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') {
    return null;
  }
  return value.slice(0, USER_AGENT_MAX_LENGTH);
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
        // Fastify measures this for us and it is valid in `onResponse`, so there
        // is no timer to start and stop. Rounded because the raw value is a
        // sub-nanosecond float that would be stored at full precision for no
        // benefit.
        durationMs: Math.round(reply.elapsedTime),
        // Grouping keys for per-endpoint reporting. Null when the request found
        // the project but no entity — that row still counts toward totals and
        // error rates, and is excluded from endpoint breakdowns.
        entity: hosted.entity,
        shape: hosted.shape,
        // Meaningful only because the server sets `trustProxy` — otherwise this
        // is the load balancer on every row.
        ip: request.ip,
        userAgent: userAgentOf(request),
      }).catch(() => undefined);
    }
    done();
  });

  /**
   * Loads a related entity, identity already resolved, so a join key reads the
   * same value the target URL routes on.
   *
   * Without it a legacy seed — records predating identity fields, which fall
   * back to `rec-<n>` — would index under `undefined` and every include
   * against that entity would quietly expand to null.
   */
  const relatedLoader = (ctx: HostedContext) => async (targetPath: string) => {
    const target = ctx.entities.get(targetPath);
    const records = await readRecords(ctx, targetPath, deps.cache, env);
    return materializeIdentity(records, target ? identityOf(target) : DEFAULT_IDENTITY_RULE);
  };

  // GET list — filter → search → sort → paginate → include (doc 08 §9, doc 19 §Phase 4)
  const listRecords = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
  ): Promise<FastifyReply> => {
    const identity = identityOf(entity);
    const fields = queryFieldsOf(entity);
    const plan = parseQuery(request.query, fields, ctx.features, env);

    // Identity is resolved up front, over the stored order, so every step below
    // treats it as an ordinary field (see `materializeIdentity`).
    const records = materializeIdentity(
      await readRecords(ctx, entity.path, deps.cache, env),
      identity,
    );

    const selected = selectRecords(records, plan, fields.searchable);
    const ordered = sortRecords(selected, plan, identity.field);
    // `total` counts what the query selected, not what the entity holds — that
    // is what makes a page count meaningful under a filter.
    const { data, total } = paginate(ordered, plan);

    // Expanded last, on the page only: the cost of an include tracks the page
    // size rather than the size of the collection.
    const expanded = await expandIncludes(
      data,
      includeTargets(entity, plan.includes),
      relatedLoader(ctx),
    );

    return reply.send({ data: expanded, meta: { page: plan.page, limit: plan.limit, total } });
  };

  // GET one
  const getRecord = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: HostedContext,
    entity: HostedEntityConfig,
    id: string,
  ): Promise<FastifyReply> => {
    const identity = identityOf(entity);
    // Only `?include=` is meaningful on a single record. The whole plan is
    // parsed regardless so an unusable parameter is reported on this URL shape
    // too, rather than being accepted here and rejected on the collection.
    const plan = parseQuery(request.query, queryFieldsOf(entity), ctx.features, env);

    const records = await readRecords(ctx, entity.path, deps.cache, env);
    const index = findRecordIndex(records, id, identity);
    if (index === -1) {
      throw notFound('Record not found');
    }

    const record: MockRecord = { [identity.field]: id, ...records[index] };
    if (plan.includes.length === 0) {
      return reply.send(record);
    }
    const [expanded] = await expandIncludes(
      [record],
      includeTargets(entity, plan.includes),
      relatedLoader(ctx),
    );
    return reply.send(expanded);
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
    // Set as soon as the project resolves, so a request that gets no further
    // still logs against the right project with a status and no attribution.
    request.hosted = { projectId: ctx.projectId, entity: null, shape: null };

    if (target.kind === 'index') {
      request.hosted.shape = 'index';
      return sendIndex(reply, ctx, env);
    }

    const entity = ctx.entities.get(target.entity.toLowerCase());
    if (!entity) {
      throw notFound('Entity not found');
    }
    // `entity.path` from the config, not `target.entity` from the URL: the lookup
    // is case-insensitive, so the URL segment may be any casing and grouping on
    // it would split one endpoint across several buckets.
    request.hosted.entity = entity.path;
    request.hosted.shape = target.kind;

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
        return getRecord(request, reply, ctx, entity, target.recordId);
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

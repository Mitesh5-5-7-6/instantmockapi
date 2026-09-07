/**
 * Project routes (doc 08 §3): list, create, get, patch, delete, parse.
 * Every route requires auth; ownership is enforced via loadOwnedProject.
 */

import type { FastifyPluginAsync } from 'fastify';
// Type-only: `mongoose` is not a dependency of this app.
import type { Types } from 'mongoose';
import {
  AppError,
  HTTP_METHODS,
  PROJECT_KINDS,
  PROJECT_STATUSES,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  countEndpoints,
  hostedUrl,
  isUsableSlug,
  unwrap,
  type InputSourceType,
  type ProjectKind,
} from '@instantmockapi/shared';
import { getPlanConfig, type EnvConfig } from '@instantmockapi/config';
import {
  ApiLog,
  Project,
  ensurePublicIdentity,
  hardDeleteProject,
  pinPublishedVersion,
  type IProject,
} from '@instantmockapi/db';
import {
  ensureSchemaIds,
  materializeRelations,
  reconcileEntityRenames,
  validateIPS,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
import { loadOwnedProject } from '../access.js';
import { escapeRegExp, listEnvelope, parsePagination, parseSort } from '../pagination.js';
import { toProjectDetail, toProjectSummary, toProjectSummaryWithCounts } from '../serializers.js';
import { parseInputSource } from '../input-parsing.js';
import { validateGenerationConfig } from '../generation-config.js';
import { buildProjectMetrics } from '../project-metrics-service.js';
import { recordVersion } from '../version-service.js';
import {
  LOG_PAGE_DEFAULT,
  LOG_PAGE_MAX,
  LOG_STATUS_CLASSES,
  listProjectLogs,
  type ProjectLogsQuery,
} from '../project-logs-service.js';

export interface ProjectRouteOptions {
  config: EnvConfig;
}

/**
 * Window for the per-project request count on the list.
 *
 * Matches the dashboard default, and both are bounded by the ApiLog 30-day TTL —
 * so this is a window count, never a lifetime total.
 */
const REQUEST_WINDOW_DAYS = 7;

interface ListQuery {
  page?: number;
  limit?: number;
  status?: (typeof PROJECT_STATUSES)[number];
  sort?: string;
  q?: string;
  include?: 'counts';
}

/**
 * Addressing the IPS carries for generators that emit URLs.
 *
 * Always taken from the live Project document, never from client input — a client
 * must not be able to rewrite its own routing by PATCHing the IPS.
 */
function addressing(project: IProject): { kind: ProjectKind; publicId?: string; slug?: string } {
  return {
    kind: project.kind ?? 'project',
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  };
}

export const projectRoutes: FastifyPluginAsync<ProjectRouteOptions> = async (app, { config }) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/projects',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: [...PROJECT_STATUSES] },
            sort: { type: 'string', pattern: '^-?(name|status|createdAt|updatedAt)$' },
            q: { type: 'string', maxLength: 200 },
            // Single-valued enum rather than a CSV list — stay boring until
            // there is a second thing to include.
            include: { type: 'string', enum: ['counts'] },
          },
        },
      },
    },
    async (request, reply) => {
      const sub = request.authUser?.sub ?? '';
      const query = request.query as ListQuery;
      const pageParams = parsePagination(query, config.maxPaginationLimit);

      const filter: Record<string, unknown> = { ownerId: sub };
      if (query.status) {
        filter['status'] = query.status;
      }
      if (query.q) {
        filter['name'] = { $regex: escapeRegExp(query.q), $options: 'i' };
      }

      const [total, projects] = await Promise.all([
        Project.countDocuments(filter),
        Project.find(filter)
          .sort(parseSort(query.sort ?? '-updatedAt'))
          .skip(pageParams.skip)
          .limit(pageParams.limit),
      ]);

      if (query.include !== 'counts') {
        return reply.send(listEnvelope(projects.map(toProjectSummary), pageParams, total));
      }

      // Counted only for the page in hand, in ONE aggregation — not one
      // countDocuments per row inside a .map(), which is the N+1 this exists to
      // avoid. Real ObjectIds: aggregation pipelines are not cast by Mongoose,
      // so stringified ids would match nothing and every row would read zero.
      const pageIds = projects.map((project) => project._id);
      const since = new Date(Date.now() - REQUEST_WINDOW_DAYS * 86_400_000);
      const counted = await ApiLog.aggregate<{ _id: unknown; count: number }>([
        { $match: { projectId: { $in: pageIds }, at: { $gte: since } } },
        { $group: { _id: '$projectId', count: { $sum: 1 } } },
      ]);
      const requestsById = new Map(counted.map((row) => [String(row._id), row.count]));

      return reply.send(
        listEnvelope(
          projects.map((project) =>
            toProjectSummaryWithCounts(project, {
              // `ips` is Schema.Types.Mixed, so an old document can be any shape.
              endpointCount: countEndpoints(
                project.ips?.entities ?? [],
                project.generationConfig?.methods ?? [],
              ),
              requestCount: requestsById.get(String(project._id)) ?? 0,
              requestWindowDays: REQUEST_WINDOW_DAYS,
            }),
          ),
          pageParams,
          total,
        ),
      );
    },
  );

  app.post(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'inputSource'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            kind: { type: 'string', enum: [...PROJECT_KINDS] },
            slug: { type: 'string', pattern: SLUG_PATTERN.source, maxLength: SLUG_MAX_LENGTH },
            description: { type: 'string', maxLength: 500 },
            inputSource: {
              type: 'object',
              required: ['type', 'raw'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['json', 'swagger', 'builder', 'docs'] },
                raw: {},
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const authUser = request.authUser;
      const body = request.body as {
        name: string;
        kind?: ProjectKind;
        slug?: string;
        description?: string;
        inputSource: { type: InputSourceType; raw: unknown };
      };
      if (body.slug !== undefined && !isUsableSlug(body.slug)) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: `slug '${body.slug}' is reserved or malformed`,
          details: [{ path: 'slug', issue: 'must be kebab-case and not a reserved word' }],
        });
      }

      // Plan gate: max projects (0 = unlimited) → 403 PLAN_LIMIT_EXCEEDED
      const planConfig = getPlanConfig(authUser?.plan ?? 'free');
      if (planConfig.maxProjects > 0) {
        const count = await Project.countDocuments({ ownerId: authUser?.sub });
        if (count >= planConfig.maxProjects) {
          throw new AppError({
            code: 'PLAN_LIMIT_EXCEEDED',
            message: `Your ${authUser?.plan ?? 'free'} plan allows at most ${planConfig.maxProjects} projects`,
          });
        }
      }

      const rawString =
        typeof body.inputSource.raw === 'string'
          ? body.inputSource.raw
          : JSON.stringify(body.inputSource.raw);

      // Instantiate first so the generated _id can be stamped into the IPS.
      // `kind` must be set before minting the public id — it selects the prefix.
      const project = new Project({
        ownerId: authUser?.sub,
        name: body.name,
        kind: body.kind ?? 'project',
        slug: body.slug ?? null,
        description: body.description ?? null,
        status: 'draft',
        inputSource: { type: body.inputSource.type, raw: rawString },
      });
      const projectId = String(project._id);

      const ips = parseInputSource(projectId, body.name, body.inputSource.type, rawString, config);
      project.ips = { ...ips, projectId, version: 1 };
      // Stable ids from birth, so the first edit is already diffable.
      //
      // Without this, a brand-new project's entities have no `ent_…` and the
      // very first rename is *undetectable*: with no id on either side, "renamed
      // Product to Item" and "deleted Product, added Item" are the same
      // document. `POST /draft` backfills for projects that predate ids, but a
      // client editing through `PATCH /projects/:id` never goes near it — and
      // the delete-plus-add reading leaves every inbound relation dangling, so
      // the rename was rejected outright.
      ensureSchemaIds(project.ips);
      project.generationConfig = ips.generationConfig;
      project.currentVersion = 1;
      await project.save();

      // Addressable from creation, so the wizard can show the hosted URL before
      // the first generation ever runs.
      await ensurePublicIdentity(project);
      project.ips = { ...project.ips, ...addressing(project) };
      await project.save();

      return reply.status(201).send(toProjectDetail(project));
    },
  );

  app.get('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    return reply.send(toProjectDetail(project));
  });

  /**
   * Per-project traffic, in the shape `/v1/dashboard` uses.
   *
   * Same `days` enum and `activityLimit` bounds on purpose: the two screens
   * answer the same question at different scopes, and a reader comparing them
   * should not have to wonder whether the windows match.
   *
   * `days` is capped at the ApiLog TTL — asking for 90 would return 30 days of
   * data under a "90 days" heading, which is worse than refusing.
   */
  app.get(
    '/projects/:id/metrics',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', enum: [7, 14, 30], default: 7 },
            activityLimit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { days: number; activityLimit: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      return reply.send(await buildProjectMetrics(project, query));
    },
  );

  /**
   * The request log itself, newest first.
   *
   * Distinct from `/metrics` rather than folded into it: this one is paged and
   * filtered per view, so combining them would make every filter change refetch
   * the aggregates too.
   */
  app.get(
    '/projects/:id/logs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: LOG_PAGE_MAX,
              default: LOG_PAGE_DEFAULT,
            },
            days: { type: 'integer', enum: [1, 7, 14, 30], default: 7 },
            method: { type: 'string', enum: [...HTTP_METHODS] },
            status: { type: 'string', enum: [...LOG_STATUS_CLASSES] },
            entity: { type: 'string', maxLength: 120 },
            // Bounded because it reaches a `$regex`. The service escapes it and
            // anchors it; the length cap keeps even a pathological pattern cheap.
            q: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const query = request.query as ProjectLogsQuery;
      // A real ObjectId, not String(project._id) — see the note in
      // project-metrics-service.ts.
      return reply.send(await listProjectLogs(project._id as Types.ObjectId, query));
    },
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', pattern: SLUG_PATTERN.source, maxLength: SLUG_MAX_LENGTH },
            description: { type: 'string', maxLength: 500 },
            ips: { type: 'object' },
            generationConfig: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        slug?: string;
        description?: string;
        ips?: Record<string, unknown>;
        generationConfig?: Record<string, unknown>;
      };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      if (body.name) {
        project.name = body.name;
      }

      if (body.description !== undefined) {
        project.description = body.description;
      }

      if (body.slug !== undefined && body.slug !== project.slug) {
        if (!isUsableSlug(body.slug)) {
          throw new AppError({
            code: 'VALIDATION_ERROR',
            message: `slug '${body.slug}' is reserved or malformed`,
            details: [{ path: 'slug', issue: 'must be kebab-case and not a reserved word' }],
          });
        }
        const taken = await Project.exists({
          ownerId: project.ownerId,
          slug: body.slug,
          _id: { $ne: project._id },
        });
        if (taken) {
          throw new AppError({
            code: 'CONFLICT',
            message: `You already have a project using the slug '${body.slug}'`,
          });
        }
        project.slug = body.slug;
        // Addressing, not schema: a rename must never bump the version (which
        // would force a regenerate) and never invalidates the old URL, because
        // resolution matches publicId alone.
        if (project.hosted.url) {
          project.hosted.url = hostedUrl(config.hostedBaseUrl, {
            projectId: String(project._id),
            publicId: project.publicId,
            slug: project.slug,
          });
        }
      }

      let schemaChanged = false;
      if (body.generationConfig) {
        project.generationConfig = unwrap(validateGenerationConfig(body.generationConfig, config));
        schemaChanged = true;
      }
      if (body.ips) {
        // Backfill the STORED side before comparing, so a project that predates
        // stable ids gets them and its next edit is diffable. Same lazy,
        // idempotent shape as `POST /draft`, and it deliberately does not bump
        // the version — minting an id is not a definition change.
        //
        // It cannot rescue *this* request when the client's document also has no
        // ids: the rename is genuinely ambiguous then, and validation says so.
        // New projects mint at creation, so that window only exists for old ones.
        ensureSchemaIds(project.ips);

        // Follow entity renames through `relation.target` and `meta.relation`,
        // which name entities by string. Before validation, because validation
        // is what rejects a target naming an entity that no longer exists.
        const reconciled = reconcileEntityRenames(project.ips as InternalProjectSchema, body.ips);
        // Validate what the client actually sent (so error paths match its own
        // indices), then materialize — otherwise this save would strip the
        // identity/foreign-key fields back out of the stored model.
        project.ips = materializeRelations(
          unwrap(
            validateIPS(
              { ...reconciled, projectId: String(project._id), ...addressing(project) },
              config.maxNestingDepth,
            ),
          ),
        );
        schemaChanged = true;
      }

      // Editing the schema or config stamps a new version (doc 08 §4: jobs
      // generated after an edit carry a fresh version + idempotency key)
      if (schemaChanged) {
        // Freeze what the runtime is serving BEFORE the definition moves. At this
        // instant `currentVersion` IS the served version, and `publishedVersionOf`
        // falls back to it — so without this pin the fallback would follow the bump
        // and 404 the live URL, which is the bug this whole split removes.
        pinPublishedVersion(project);
        project.currentVersion += 1;
        project.ips = {
          ...project.ips,
          version: project.currentVersion,
          generationConfig: project.generationConfig,
        };
      }

      await project.save();

      // Record the snapshot AFTER the save, so a version number never appears in
      // history before the project has committed to it. This edit path used to
      // advance `currentVersion` and write no snapshot at all, which left an
      // unexplained gap in the history list and a version §24 could not compare.
      if (schemaChanged) {
        await recordVersion({
          project,
          note: 'Definition edited',
          changeType: 'FEATURE',
          createdBy: request.authUser?.sub ?? null,
        });
      }

      return reply.send(toProjectDetail(project));
    },
  );

  app.delete('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    await hardDeleteProject(String(project._id));
    return reply.status(204).send();
  });

  app.post('/projects/:id/parse', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

    const ips = parseInputSource(
      String(project._id),
      project.name,
      project.inputSource.type,
      project.inputSource.raw,
      config,
    );
    // Refresh the draft IPS; the user's config edits and version survive re-parse
    project.ips = {
      ...ips,
      projectId: String(project._id),
      version: project.currentVersion,
      generationConfig: project.generationConfig,
    };
    await project.save();

    return reply.send({ ips: project.ips });
  });
};

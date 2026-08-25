/**
 * Project routes (doc 08 §3): list, create, get, patch, delete, parse.
 * Every route requires auth; ownership is enforced via loadOwnedProject.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  AppError,
  PROJECT_KINDS,
  PROJECT_STATUSES,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  hostedUrl,
  isUsableSlug,
  unwrap,
  type InputSourceType,
  type ProjectKind,
} from '@instantmockapi/shared';
import { getPlanConfig, type EnvConfig } from '@instantmockapi/config';
import {
  Project,
  ensurePublicIdentity,
  hardDeleteProject,
  type IProject,
} from '@instantmockapi/db';
import { materializeRelations, validateIPS } from '@instantmockapi/ips';
import { loadOwnedProject } from '../access.js';
import { escapeRegExp, listEnvelope, parsePagination, parseSort } from '../pagination.js';
import { toProjectDetail, toProjectSummary } from '../serializers.js';
import { parseInputSource } from '../input-parsing.js';
import { validateGenerationConfig } from '../generation-config.js';

export interface ProjectRouteOptions {
  config: EnvConfig;
}

interface ListQuery {
  page?: number;
  limit?: number;
  status?: (typeof PROJECT_STATUSES)[number];
  sort?: string;
  q?: string;
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

      return reply.send(listEnvelope(projects.map(toProjectSummary), pageParams, total));
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
        // Validate what the client actually sent (so error paths match its own
        // indices), then materialize — otherwise this save would strip the
        // identity/foreign-key fields back out of the stored model.
        project.ips = materializeRelations(
          unwrap(
            validateIPS(
              { ...body.ips, projectId: String(project._id), ...addressing(project) },
              config.maxNestingDepth,
            ),
          ),
        );
        schemaChanged = true;
      }

      // Editing the schema or config stamps a new version (doc 08 §4: jobs
      // generated after an edit carry a fresh version + idempotency key)
      if (schemaChanged) {
        project.currentVersion += 1;
        project.ips = {
          ...project.ips,
          version: project.currentVersion,
          generationConfig: project.generationConfig,
        };
      }

      await project.save();
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

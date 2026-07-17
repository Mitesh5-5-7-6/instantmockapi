/**
 * Project routes (doc 08 §3): list, create, get, patch, delete, parse.
 * Every route requires auth; ownership is enforced via loadOwnedProject.
 */

import type { FastifyPluginAsync } from 'fastify';
import { AppError, PROJECT_STATUSES, type InputSourceType } from '@instantmockapi/shared';
import { getPlanConfig, type EnvConfig } from '@instantmockapi/config';
import { Project, hardDeleteProject } from '@instantmockapi/db';
import { validateIPS } from '@instantmockapi/ips';
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
        inputSource: { type: InputSourceType; raw: unknown };
      };

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

      // Instantiate first so the generated _id can be stamped into the IPS
      const project = new Project({
        ownerId: authUser?.sub,
        name: body.name,
        status: 'draft',
        inputSource: { type: body.inputSource.type, raw: rawString },
      });
      const projectId = String(project._id);

      const ips = parseInputSource(projectId, body.name, body.inputSource.type, rawString, config);
      project.ips = { ...ips, projectId, version: 1 };
      project.generationConfig = ips.generationConfig;
      project.currentVersion = 1;
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
        ips?: Record<string, unknown>;
        generationConfig?: Record<string, unknown>;
      };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      if (body.name) {
        project.name = body.name;
      }

      let schemaChanged = false;
      if (body.generationConfig) {
        const cfg = validateGenerationConfig(body.generationConfig, config);
        if (!cfg.ok) {
          throw cfg.error;
        }
        project.generationConfig = cfg.value;
        schemaChanged = true;
      }
      if (body.ips) {
        const validated = validateIPS(
          { ...body.ips, projectId: String(project._id) },
          config.maxNestingDepth,
        );
        if (!validated.ok) {
          throw validated.error;
        }
        project.ips = validated.value;
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

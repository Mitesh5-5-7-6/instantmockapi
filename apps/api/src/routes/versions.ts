/**
 * Version routes (doc 08 §5): history listing and snapshot restore (doc 03 §7).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { Version } from '@instantmockapi/db';
import { loadOwnedProject, notFound } from '../access.js';
import { listEnvelope, parsePagination } from '../pagination.js';
import { toProjectDetail, toVersionView } from '../serializers.js';

export interface VersionRouteOptions {
  config: EnvConfig;
}

export const versionRoutes: FastifyPluginAsync<VersionRouteOptions> = async (app, { config }) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/projects/:id/versions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; limit?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const pageParams = parsePagination(query, config.maxPaginationLimit);

      const [total, versions] = await Promise.all([
        Version.countDocuments({ projectId: project._id }),
        Version.find({ projectId: project._id })
          .sort({ version: -1 })
          .skip(pageParams.skip)
          .limit(pageParams.limit),
      ]);

      return reply.send(listEnvelope(versions.map(toVersionView), pageParams, total));
    },
  );

  app.post(
    '/projects/:id/versions/:version/restore',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'version'],
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, version } = request.params as { id: string; version: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      const snapshot = await Version.findOne({ projectId: project._id, version });
      if (!snapshot) {
        throw notFound('Version');
      }

      // Restore copies the snapshot's IPS + config forward onto the working
      // draft and advances currentVersion so the NEXT generation stamps a fresh
      // version from this restored model (doc 03 §7, doc 07 §5) — history is
      // append-only and never rewound. No snapshot/artifacts are written here;
      // they materialize when the user generates (the artifact grid still shows
      // the last-generated set until then, at their older versions).
      project.currentVersion += 1;
      project.generationConfig = snapshot.configSnapshot;
      project.ips = {
        ...snapshot.ipsSnapshot,
        projectId: String(project._id),
        version: project.currentVersion,
        generationConfig: snapshot.configSnapshot,
      };
      await project.save();

      return reply.send(toProjectDetail(project));
    },
  );
};

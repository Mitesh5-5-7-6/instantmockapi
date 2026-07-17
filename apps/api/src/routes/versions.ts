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

      // Restoring stamps a new version whose content is the snapshot's —
      // history is append-only, never rewound (doc 03 §7)
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

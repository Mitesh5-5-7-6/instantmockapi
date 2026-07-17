/**
 * Artifact routes (doc 08 §5): registry listing, single record, download,
 * and full export. Download/export serve the registry's storageRef — content
 * streaming from object storage is wired when Worker G lands (Phase 5).
 */

import type { FastifyPluginAsync } from 'fastify';
import { ARTIFACT_TYPES, type ArtifactType } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import type { IArtifact, IProject } from '@instantmockapi/db';
import { getArtifactRecord, getArtifactsForVersion } from '@instantmockapi/registry';
import { loadOwnedProject, notFound } from '../access.js';
import { toArtifactView } from '../serializers.js';

export interface ArtifactRouteOptions {
  config: EnvConfig;
}

const versionQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { version: { type: 'integer', minimum: 1 } },
} as const;

async function loadCompletedArtifact(
  project: IProject,
  artifactType: ArtifactType,
  version: number,
): Promise<IArtifact> {
  const record = await getArtifactRecord(String(project._id), artifactType, version);
  if (!record.ok) {
    throw record.error;
  }
  const artifact = record.value;
  if (!artifact || artifact.status !== 'completed' || !artifact.storageRef) {
    throw notFound(`Generated ${artifactType} artifact`);
  }
  return artifact;
}

export const artifactRoutes: FastifyPluginAsync<ArtifactRouteOptions> = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/projects/:id/artifacts',
    { schema: { querystring: versionQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { version?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const version = query.version ?? project.currentVersion;

      const artifacts = await getArtifactsForVersion(String(project._id), version);
      if (!artifacts.ok) {
        throw artifacts.error;
      }
      return reply.send({ data: artifacts.value.map(toArtifactView), meta: { version } });
    },
  );

  app.get(
    '/projects/:id/artifacts/:type',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'type'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: [...ARTIFACT_TYPES] },
          },
        },
        querystring: versionQuerySchema,
      },
    },
    async (request, reply) => {
      const { id, type } = request.params as { id: string; type: ArtifactType };
      const query = request.query as { version?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const version = query.version ?? project.currentVersion;

      const record = await getArtifactRecord(String(project._id), type, version);
      if (!record.ok) {
        throw record.error;
      }
      if (!record.value) {
        throw notFound('Artifact');
      }
      return reply.send(toArtifactView(record.value));
    },
  );

  app.get(
    '/projects/:id/artifacts/:type/download',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'type'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: [...ARTIFACT_TYPES] },
          },
        },
        querystring: versionQuerySchema,
      },
    },
    async (request, reply) => {
      const { id, type } = request.params as { id: string; type: ArtifactType };
      const query = request.query as { version?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const version = query.version ?? project.currentVersion;

      const artifact = await loadCompletedArtifact(project, type, version);
      return reply.send({
        artifactType: artifact.artifactType,
        version: artifact.version,
        storageRef: artifact.storageRef,
        note: 'Content streaming from object storage arrives with the worker pipeline (Phase 5)',
      });
    },
  );

  app.get(
    '/projects/:id/export',
    { schema: { querystring: versionQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { version?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const version = query.version ?? project.currentVersion;

      const artifact = await loadCompletedArtifact(project, 'export_zip', version);
      return reply.send({
        artifactType: artifact.artifactType,
        version: artifact.version,
        storageRef: artifact.storageRef,
        note: 'Content streaming from object storage arrives with the worker pipeline (Phase 5)',
      });
    },
  );
};

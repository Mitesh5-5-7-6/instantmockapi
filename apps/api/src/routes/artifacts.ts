/**
 * Artifact routes (doc 08 §5): registry listing, single record, download,
 * and full export. Downloads are server-mediated through object storage —
 * storageRefs never become public URLs (doc 13 §6). Multi-file artifacts
 * download as a `{ files }` JSON bundle; single-file artifacts (openapi,
 * postman, hosting config, export zip) download as the raw file.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ARTIFACT_TYPES, type ArtifactType } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import type { IArtifact, IProject } from '@instantmockapi/db';
import { getArtifactRecord, getArtifactsForVersion } from '@instantmockapi/registry';
import { decodeBundle, isBundleKey, type StorageClient } from '@instantmockapi/storage';
import { loadOwnedProject, notFound } from '../access.js';
import { toArtifactView } from '../serializers.js';

export interface ArtifactRouteOptions {
  config: EnvConfig;
  storage: StorageClient;
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

/** Serve an artifact's stored content: raw file or `{ files }` bundle JSON. */
async function sendArtifactContent(
  reply: FastifyReply,
  storage: StorageClient,
  artifact: IArtifact,
): Promise<FastifyReply> {
  const storageRef = artifact.storageRef as string;
  const object = await storage.get(storageRef);
  if (!object) {
    throw notFound(`Stored ${artifact.artifactType} content`);
  }

  if (isBundleKey(storageRef)) {
    const bundle = decodeBundle(object.body);
    return reply.type('application/json').send({
      artifactType: artifact.artifactType,
      version: artifact.version,
      files: bundle.files,
    });
  }

  const filename = storageRef.split('/').pop() ?? artifact.artifactType;
  return reply
    .type(object.contentType)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(Buffer.from(object.body));
}

export const artifactRoutes: FastifyPluginAsync<ArtifactRouteOptions> = async (
  app,
  { storage },
) => {
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
      return sendArtifactContent(reply, storage, artifact);
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
      return sendArtifactContent(reply, storage, artifact);
    },
  );
};

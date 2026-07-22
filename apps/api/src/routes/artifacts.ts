/**
 * Artifact routes (doc 08 §5): registry listing, single record, download,
 * and full export. Downloads are server-mediated through object storage —
 * storageRefs never become public URLs (doc 13 §6). Multi-file artifacts
 * download as a `{ files }` JSON bundle; single-file artifacts (openapi,
 * postman, hosting config, export zip) download as the raw file.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ARTIFACT_TYPES, AppError, unwrap, type ArtifactType } from '@instantmockapi/shared';
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

/** Binary artifacts have no meaningful inline text view — download only. */
const BINARY_ARTIFACTS = new Set<ArtifactType>(['export_zip']);

async function loadCompletedArtifact(
  project: IProject,
  artifactType: ArtifactType,
  version: number,
): Promise<IArtifact> {
  const artifact = unwrap(await getArtifactRecord(String(project._id), artifactType, version));
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

      const artifacts = unwrap(await getArtifactsForVersion(String(project._id), version));
      return reply.send({ data: artifacts.map(toArtifactView), meta: { version } });
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

      const record = unwrap(await getArtifactRecord(String(project._id), type, version));
      if (!record) {
        throw notFound('Artifact');
      }
      return reply.send(toArtifactView(record));
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

  // Inline content for the code-viewer (doc 08 §5). Normalizes single-file and
  // multi-file (bundle) artifacts into one `{ files }` shape so the client
  // renders them uniformly; unlike /download it never sets content-disposition.
  app.get(
    '/projects/:id/artifacts/:type/content',
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

      if (BINARY_ARTIFACTS.has(type)) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: `${type} is a binary bundle; use the download endpoint`,
        });
      }

      const artifact = await loadCompletedArtifact(project, type, version);
      const storageRef = artifact.storageRef as string;
      const object = await storage.get(storageRef);
      if (!object) {
        throw notFound(`Stored ${type} content`);
      }

      let files: Record<string, string>;
      if (isBundleKey(storageRef)) {
        files = decodeBundle(object.body).files;
      } else {
        const filename = storageRef.split('/').pop() ?? type;
        files = { [filename]: new TextDecoder().decode(object.body) };
      }

      return reply.send({ artifactType: type, version: artifact.version, files });
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

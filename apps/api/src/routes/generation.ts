/**
 * Generation routes (doc 08 §4): full generate, partial regenerate, and
 * generate-again after expiry. All respond 202 with { jobId, status } —
 * generation is async; progress arrives via GET /jobs/{id} or SSE.
 */

import type { FastifyPluginAsync } from 'fastify';
import { AppError, type ArtifactType } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { loadOwnedProject } from '../access.js';
import {
  REGENERATABLE_ARTIFACTS,
  deriveRequestedArtifacts,
  validateGenerationConfig,
} from '../generation-config.js';
import { createGenerationJob } from '../generation-service.js';

export interface GenerationRouteOptions {
  config: EnvConfig;
}

export const generationRoutes: FastifyPluginAsync<GenerationRouteOptions> = async (
  app,
  { config },
) => {
  app.addHook('onRequest', app.authenticate);

  app.post('/projects/:id/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

    const body = (request.body ?? {}) as { generationConfig?: unknown };
    const cfg = validateGenerationConfig(body.generationConfig ?? project.generationConfig, config);
    if (!cfg.ok) {
      throw cfg.error;
    }

    const job = await createGenerationJob({
      project,
      type: 'full',
      requestedArtifacts: deriveRequestedArtifacts(cfg.value),
      generationConfig: cfg.value,
      plan: request.authUser?.plan ?? 'free',
    });
    return reply.status(202).send({ jobId: job.jobId, status: job.status });
  });

  app.post(
    '/projects/:id/regenerate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['artifacts'],
          additionalProperties: false,
          properties: {
            artifacts: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: [...REGENERATABLE_ARTIFACTS] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { artifacts } = request.body as { artifacts: ArtifactType[] };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      const cfg = validateGenerationConfig(project.generationConfig, config);
      if (!cfg.ok) {
        throw cfg.error;
      }

      const job = await createGenerationJob({
        project,
        type: 'partial',
        requestedArtifacts: artifacts,
        generationConfig: cfg.value,
        plan: request.authUser?.plan ?? 'free',
      });
      return reply.status(202).send({ jobId: job.jobId, status: job.status });
    },
  );

  app.post('/projects/:id/generate-again', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

    if (project.status !== 'expired') {
      throw new AppError({
        code: 'CONFLICT',
        message: 'generate-again is only available for expired projects',
      });
    }

    const cfg = validateGenerationConfig(project.generationConfig, config);
    if (!cfg.ok) {
      throw cfg.error;
    }

    // Re-run from the kept shell: a fresh version so artifacts and the
    // idempotency key never collide with the expired generation (doc 07 §6)
    project.currentVersion += 1;
    project.ips = { ...project.ips, version: project.currentVersion };

    const job = await createGenerationJob({
      project,
      type: 'full',
      requestedArtifacts: deriveRequestedArtifacts(cfg.value),
      generationConfig: cfg.value,
      plan: request.authUser?.plan ?? 'free',
    });
    return reply.status(202).send({ jobId: job.jobId, status: job.status });
  });
};

/**
 * Edit an existing project's data model with a prompt (Phase 7).
 *
 *     POST /projects/:id/draft/ai  { prompt }  ──▶ 202, an AiProposal
 *
 * The proposal carries `editsProjectId` and runs on the same worker as a
 * new-project proposal; the worker revises the project's open draft with the
 * prompt as the instruction. It is read, cancelled and retried through the
 * ordinary `/ai/proposals/:id` routes.
 *
 * Applying the result is deliberately not an AI route. The editor merges it into
 * its form and saves with `PATCH /projects/:id/draft`, so an AI edit reaches the
 * definition through exactly the same review, impact analysis and commit as a
 * hand edit.
 */

import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { AiProposal } from '@instantmockapi/db';
import { PROMPT_VERSION } from '@instantmockapi/ai';
import { loadOwnedProject } from '../access.js';
import { loadDraft } from '../draft-service.js';
import { toAiProposalView } from '../ai-proposal-serializers.js';
import {
  AI_PROPOSAL_LIMIT,
  IMAGES_SCHEMA,
  IMAGE_BODY_LIMIT,
  assertProposalBudget,
  enqueueProposalOrFail,
  readPromptInput,
} from '../ai-proposal-access.js';

export interface AiProjectEditRouteOptions {
  config: EnvConfig;
}

export const aiProjectEditRoutes: FastifyPluginAsync<AiProjectEditRouteOptions> = async (
  app,
  { config },
) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/projects/:id/draft/ai',
    {
      config: { rateLimit: AI_PROPOSAL_LIMIT },
      bodyLimit: IMAGE_BODY_LIMIT,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', maxLength: 64 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', maxLength: 1000 },
            images: IMAGES_SCHEMA,
            responseLanguage: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z]{2,4})?$' },
          },
        },
      },
    },
    async (request, reply) => {
      const sub = request.authUser?.sub ?? '';
      const body = request.body as {
        prompt?: string;
        images?: { mimeType: string; data: string }[];
        responseLanguage?: string;
      };
      const { prompt, images } = readPromptInput(body, {
        blank: 'Describe the change you want to make, or attach a photo of it.',
        whenImageOnly: 'Apply the changes shown in the attached image.',
      });
      // Owner check first, so another user's project is a 404 and not a 503.
      const project = await loadOwnedProject((request.params as { id: string }).id, sub);
      // The result is applied to the open draft, so there has to be one.
      await loadDraft(project);
      if (!config.geminiApiKey) {
        throw new AppError({
          code: 'AI_NOT_CONFIGURED',
          message: 'AI generation is not configured on this server.',
        });
      }
      await assertProposalBudget(sub);

      // An Auth API has no proposal kind; the model then keeps its relational shape.
      const kind =
        project.kind === 'project' || project.kind === 'single' ? project.kind : undefined;
      const doc = await AiProposal.create({
        ownerId: sub,
        prompt,
        ...(images.length > 0 ? { images, imageCount: images.length } : {}),
        // The project's own name and kind, so the model keeps both.
        hints: { name: project.name, ...(kind ? { kind } : {}) },
        responseLanguage: body.responseLanguage ?? null,
        model: config.geminiModel,
        promptVersion: PROMPT_VERSION,
        editsProjectId: project._id,
      });
      await enqueueProposalOrFail(doc);
      return reply.status(202).send(toAiProposalView(doc));
    },
  );
};

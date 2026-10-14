/**
 * AI proposal review routes (Phase 7 SP2): draft autosave, and later in this
 * sub-project regenerate, adopt and translate. Owner-scoped like the SP1 routes.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { AiProposal } from '@instantmockapi/db';
import { conflict, idParams, loadOwnedProposal } from '../ai-proposal-access.js';
import { DRAFT_FIELDS_SCHEMA, buildDraft, type DraftInput } from '../ai-draft.js';

export interface AiProposalReviewRouteOptions {
  config: EnvConfig;
}

export const aiProposalReviewRoutes: FastifyPluginAsync<AiProposalReviewRouteOptions> = async (
  app,
  { config },
) => {
  app.addHook('onRequest', app.authenticate);

  app.patch(
    '/ai/proposals/:id/draft',
    {
      schema: {
        params: idParams,
        body: {
          ...DRAFT_FIELDS_SCHEMA,
          required: [...DRAFT_FIELDS_SCHEMA.required, 'revision'],
          properties: {
            ...DRAFT_FIELDS_SCHEMA.properties,
            revision: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as DraftInput & { revision: number };
      const owned = await loadOwnedProposal(id, request.authUser?.sub ?? '');
      if (owned.status !== 'ready') {
        return conflict(reply, owned, 'This proposal can no longer be edited.');
      }
      const built = buildDraft(body, config);
      // Optimistic concurrency: the save applies only on top of the revision this
      // tab last saw, so a second tab can never silently overwrite the first.
      const saved = await AiProposal.findOneAndUpdate(
        {
          _id: owned._id,
          status: 'ready',
          ...(body.revision === 0 ? { draft: null } : { 'draft.revision': body.revision }),
        },
        { $set: { draft: { ...built.draft, revision: body.revision + 1, savedAt: new Date() } } },
        { new: true },
      );
      if (!saved) {
        const current = (await AiProposal.findById(owned._id)) ?? owned;
        if (current.status !== 'ready') {
          return conflict(reply, current, 'This proposal can no longer be edited.');
        }
        return reply.status(409).send({
          error: { code: 'CONFLICT', message: 'This proposal was changed in another tab.' },
          draft: current.draft,
        });
      }
      return reply.send({ draft: saved.draft, issues: built.issues });
    },
  );
};

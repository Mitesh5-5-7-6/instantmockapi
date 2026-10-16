/**
 * AI proposal review routes (Phase 7 SP2): draft autosave, regenerate, adopt and
 * translate. Owner-scoped like the SP1 routes.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { AiProposal } from '@instantmockapi/db';
import { AppError, getErrorMessage, logger } from '@instantmockapi/shared';
import { PROMPT_VERSION } from '@instantmockapi/ai';
import { enqueueAiProposalJob, enqueueAiTranslateJob } from '@instantmockapi/queue';
import {
  AI_PROPOSAL_LIMIT,
  assertProposalBudget,
  conflict,
  idParams,
  loadOwnedNewProjectProposal,
} from '../ai-proposal-access.js';
import { toAiProposalView } from '../ai-proposal-serializers.js';
import { DRAFT_FIELDS_SCHEMA, buildDraft, type DraftInput } from '../ai-draft.js';

const LANGUAGE_PATTERN = '^[a-z]{2,3}(-[A-Za-z]{2,4})?$';
const withEmptyBody = (request: { body: unknown }, _reply: unknown, done: () => void) => {
  request.body ??= {};
  done();
};

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
      const owned = await loadOwnedNewProjectProposal(id, request.authUser?.sub ?? '');
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

  app.post(
    '/ai/proposals/:id/regenerate',
    {
      config: { rateLimit: AI_PROPOSAL_LIMIT },
      preValidation: withEmptyBody,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: { type: 'string', maxLength: 1000 },
            instruction: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sub = request.authUser?.sub ?? '';
      const body = request.body as { answers?: string; instruction?: string };
      const parent = await loadOwnedNewProjectProposal(id, sub);
      if (parent.status !== 'ready') {
        return conflict(reply, parent, 'Only a ready proposal can be regenerated.');
      }
      if (parent.childId) {
        const running = await AiProposal.findOne({ _id: parent.childId, status: 'generating' });
        if (running) {
          return conflict(reply, parent, 'A regeneration is already running.');
        }
      }
      await assertProposalBudget(sub);
      const answers = body.answers?.trim();
      const instruction = body.instruction?.trim();
      const child = await AiProposal.create({
        ownerId: sub,
        prompt: parent.prompt,
        hints: { ...(parent.toObject().hints ?? {}) },
        responseLanguage: parent.responseLanguage,
        model: config.geminiModel,
        promptVersion: PROMPT_VERSION,
        parentId: parent._id,
        clarification:
          answers || instruction
            ? { ...(answers ? { answers } : {}), ...(instruction ? { instruction } : {}) }
            : null,
      });
      // Compare-and-swap on the childId we read: of two concurrent regenerates only
      // one link wins, so only one child is ever left generating.
      const linked = await AiProposal.updateOne(
        { _id: parent._id, status: 'ready', childId: parent.childId ?? null },
        { $set: { childId: child._id } },
      );
      if (linked.matchedCount === 0) {
        await AiProposal.updateOne(
          { _id: child._id, status: 'generating' },
          { $set: { status: 'cancelled', stage: null } },
        );
        const current = (await AiProposal.findById(parent._id)) ?? parent;
        return conflict(reply, current, 'A regeneration is already running.');
      }
      try {
        await enqueueAiProposalJob(String(child._id), child.runs);
      } catch (cause) {
        logger.error('Could not enqueue AI regenerate job', {
          proposalId: String(child._id),
          error: getErrorMessage(cause),
        });
        const message = 'Could not start generation. Please retry.';
        await AiProposal.updateOne(
          { _id: child._id, status: 'generating' },
          {
            $set: {
              status: 'failed',
              stage: null,
              error: { code: 'AI_GENERATION_FAILED', message, details: [] },
            },
          },
        );
        throw new AppError({ code: 'AI_GENERATION_FAILED', message, statusCode: 503 });
      }
      return reply.status(202).send(toAiProposalView(child));
    },
  );

  app.post(
    '/ai/proposals/:id/adopt',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['draft', 'parentRevision'],
          additionalProperties: false,
          properties: {
            draft: DRAFT_FIELDS_SCHEMA,
            parentRevision: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sub = request.authUser?.sub ?? '';
      const child = await loadOwnedNewProjectProposal(id, sub);
      if (child.status !== 'ready' || !child.parentId) {
        return conflict(reply, child, 'Only a ready regeneration can be adopted.');
      }
      const parent = await AiProposal.findOne({ _id: child.parentId, ownerId: sub });
      if (!parent || parent.status !== 'ready' || String(parent.childId) !== String(child._id)) {
        return conflict(
          reply,
          parent ?? child,
          'The original proposal changed; this suggestion can no longer be adopted.',
        );
      }
      const body = request.body as { draft: DraftInput; parentRevision: number };
      const built = buildDraft(body.draft, config);
      // The parent goes first, and only at the draft revision the merge was built
      // from: if another tab saved the parent since, adopting would silently drop
      // those edits, so the user is sent back to review them instead.
      const superseded = await AiProposal.updateOne(
        {
          _id: parent._id,
          status: 'ready',
          childId: child._id,
          ...(body.parentRevision === 0
            ? { draft: null }
            : { 'draft.revision': body.parentRevision }),
        },
        { $set: { status: 'superseded' } },
      );
      if (superseded.matchedCount === 0) {
        const current = (await AiProposal.findById(parent._id)) ?? parent;
        if (current.status !== 'ready' || String(current.childId) !== String(child._id)) {
          return conflict(
            reply,
            current,
            'The original proposal changed; this suggestion can no longer be adopted.',
          );
        }
        return conflict(
          reply,
          current,
          'Your draft changed in another tab; review it before applying.',
        );
      }
      const saved = await AiProposal.findOneAndUpdate(
        { _id: child._id, status: 'ready', draft: null },
        { $set: { draft: { ...built.draft, revision: 1, savedAt: new Date() } } },
        { new: true },
      );
      if (!saved) {
        // Should be unreachable: only adopt writes a child's draft, and it supersedes
        // the parent first, which a second adopt cannot do again. If it happens the
        // parent is superseded without a drafted child, so it is logged loudly.
        logger.error('AI adopt superseded the parent but could not save the child draft', {
          proposalId: String(child._id),
          parentId: String(parent._id),
        });
        return conflict(reply, child, 'This suggestion was already adopted.');
      }
      return reply.send({ draft: saved.draft, issues: built.issues });
    },
  );

  app.post(
    '/ai/proposals/:id/translate',
    {
      config: { rateLimit: AI_PROPOSAL_LIMIT },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['language'],
          additionalProperties: false,
          properties: { language: { type: 'string', pattern: LANGUAGE_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sub = request.authUser?.sub ?? '';
      const { language } = request.body as { language: string };
      const owned = await loadOwnedNewProjectProposal(id, sub);
      if (owned.status !== 'ready' || !owned.result) {
        return conflict(reply, owned, 'Only a ready proposal can be translated.');
      }
      const current = owned.responseLanguage ?? owned.result.detectedLanguage;
      if (language === current) {
        if (!owned.translation) {
          return reply.send(toAiProposalView(owned));
        }
        // "Keep this language": dismiss a pending or failed translation; no job, no budget.
        const cleared = await AiProposal.findOneAndUpdate(
          { _id: owned._id, status: 'ready' },
          { $set: { translation: null } },
          { new: true },
        );
        if (!cleared) {
          return conflict(reply, owned, 'Only a ready proposal can be translated.');
        }
        return reply.send(toAiProposalView(cleared));
      }
      await assertProposalBudget(sub);
      const doc = await AiProposal.findOneAndUpdate(
        { _id: owned._id, status: 'ready' },
        {
          // requestedAt is the expiry clock; autosaves bump updatedAt so it cannot be used.
          $set: {
            translation: { status: 'pending', language, requestedAt: new Date() },
            runStartedAt: new Date(),
          },
          $inc: { translations: 1 },
        },
        { new: true },
      );
      if (!doc) {
        return conflict(reply, owned, 'Only a ready proposal can be translated.');
      }
      try {
        await enqueueAiTranslateJob(String(doc._id), doc.runs, doc.translations, language);
      } catch (cause) {
        logger.error('Could not enqueue AI translate job', {
          proposalId: String(doc._id),
          error: getErrorMessage(cause),
        });
        const message = 'Could not start translation. Please retry.';
        await AiProposal.updateOne(
          {
            _id: doc._id,
            status: 'ready',
            'translation.status': 'pending',
            'translation.language': language,
            translations: doc.translations,
          },
          { $set: { translation: { status: 'failed', language, message } } },
        );
        throw new AppError({ code: 'AI_GENERATION_FAILED', message, statusCode: 503 });
      }
      return reply.status(202).send(toAiProposalView(doc));
    },
  );
};

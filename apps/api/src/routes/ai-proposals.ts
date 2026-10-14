/**
 * AI proposal routes (Phase 7 SP1): propose → poll → commit.
 *
 * The API never calls the AI provider: proposing enqueues a job and returns,
 * because a Gemini round trip (plus one repair) can outlast a serverless
 * request. Every route is owner-scoped; another user's proposal is a 404.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  AppError,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  getErrorMessage,
  isUsableSlug,
  logger,
} from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { AiProposal, Project, mongoose, type IAiProposal } from '@instantmockapi/db';
import { enqueueAiProposalJob } from '@instantmockapi/queue';
import { PROMPT_VERSION, toBuilderShape } from '@instantmockapi/ai';
import { newProjectGenerationConfig } from '@instantmockapi/ips';
import { parseInputSource } from '../input-parsing.js';
import { assertProjectQuota, createProjectRecord } from '../project-create.js';
import { toProjectDetail } from '../serializers.js';
import { listEnvelope, parsePagination } from '../pagination.js';
import { toAiProposalSummary, toAiProposalView } from '../ai-proposal-serializers.js';

export interface AiProposalRouteOptions {
  config: EnvConfig;
}

/**
 * Twenty proposals an hour per user. Each one costs one or two model calls, so
 * this is a cost guard as much as an abuse guard. Keyed by the global generator
 * (the verified user id, else the IP).
 */
const AI_PROPOSAL_LIMIT = { max: 20, timeWindow: 60 * 60_000 };

/** A job cannot legitimately run this long; past it, the proposal was lost (e.g. Redis restarted). */
const STUCK_AFTER_MS = 10 * 60_000;

const KINDS = ['project', 'single'] as const;
type ProposalKindInput = (typeof KINDS)[number];

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', maxLength: 64 } },
} as const;

interface CreateBody {
  prompt: string;
  name?: string;
  kind?: ProposalKindInput;
  description?: string;
  responseLanguage?: string;
}

interface CommitBody {
  kind?: ProposalKindInput;
  name?: string;
  slug?: string;
  description?: string;
  blueprint?: { entities: unknown[]; generationConfig?: unknown };
}

function notFound(): AppError {
  return new AppError({ code: 'NOT_FOUND', message: 'Proposal not found' });
}

async function loadOwnedProposal(id: string, ownerId: string): Promise<IAiProposal> {
  if (!mongoose.isValidObjectId(id)) {
    throw notFound();
  }
  const doc = await AiProposal.findOne({ _id: id, ownerId });
  if (!doc) {
    throw notFound();
  }
  return doc;
}

/** Lazy expiry: settle a lost job on read instead of running a sweeper. */
async function expireIfStuck(doc: IAiProposal): Promise<IAiProposal> {
  if (doc.status !== 'generating' || doc.updatedAt.getTime() > Date.now() - STUCK_AFTER_MS) {
    return doc;
  }
  const expired = await AiProposal.findOneAndUpdate(
    { _id: doc._id, status: 'generating', updatedAt: doc.updatedAt },
    {
      $set: {
        status: 'failed',
        stage: null,
        error: {
          code: 'AI_GENERATION_FAILED',
          message: 'Generation timed out. Please retry.',
          details: [],
        },
      },
    },
    { new: true },
  );
  return expired ?? (await AiProposal.findById(doc._id)) ?? doc;
}

function conflict(reply: FastifyReply, doc: IAiProposal, message: string) {
  return reply.status(409).send({
    error: {
      code: 'CONFLICT',
      message,
      status: doc.status,
      ...(doc.projectId ? { projectId: String(doc.projectId) } : {}),
    },
  });
}

export const aiProposalRoutes: FastifyPluginAsync<AiProposalRouteOptions> = async (
  app,
  { config },
) => {
  app.addHook('onRequest', app.authenticate);

  /**
   * Queue the job, or settle the proposal as failed and answer 503. The prompt
   * stays in history either way, so the user can retry without retyping. The
   * cause (e.g. a Redis error) is logged, never sent to the client.
   */
  async function enqueueOrFail(doc: IAiProposal): Promise<void> {
    try {
      await enqueueAiProposalJob(String(doc._id), doc.runs);
    } catch (cause) {
      logger.error('Could not enqueue AI proposal job', {
        proposalId: String(doc._id),
        error: getErrorMessage(cause),
      });
      const message = 'Could not start generation. Please retry.';
      await AiProposal.updateOne(
        { _id: doc._id, status: 'generating' },
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
  }

  app.post(
    '/ai/proposals',
    {
      config: { rateLimit: AI_PROPOSAL_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', minLength: 1, maxLength: 1000 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            kind: { type: 'string', enum: [...KINDS] },
            description: { type: 'string', maxLength: 500 },
            responseLanguage: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z]{2,4})?$' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as CreateBody;
      const prompt = body.prompt.trim();
      if (!prompt) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: 'Describe the API you want to build.',
          details: [{ path: 'prompt', issue: 'must not be blank' }],
        });
      }
      if (!config.geminiApiKey) {
        throw new AppError({
          code: 'AI_NOT_CONFIGURED',
          message: 'AI generation is not configured on this server.',
        });
      }

      const doc = await AiProposal.create({
        ownerId: request.authUser?.sub,
        prompt,
        hints: {
          ...(body.name?.trim() ? { name: body.name.trim() } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.description?.trim() ? { description: body.description.trim() } : {}),
        },
        responseLanguage: body.responseLanguage ?? null,
        model: config.geminiModel,
        promptVersion: PROMPT_VERSION,
      });
      await enqueueOrFail(doc);
      return reply.status(202).send(toAiProposalView(doc));
    },
  );

  app.get(
    '/ai/proposals',
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
      const filter = { ownerId: request.authUser?.sub };
      const page = parsePagination(
        request.query as { page?: number; limit?: number },
        config.maxPaginationLimit,
      );
      const [total, docs] = await Promise.all([
        AiProposal.countDocuments(filter),
        AiProposal.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit),
      ]);
      return reply.send(listEnvelope(docs.map(toAiProposalSummary), page, total));
    },
  );

  app.get('/ai/proposals/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await expireIfStuck(await loadOwnedProposal(id, request.authUser?.sub ?? ''));
    return reply.send(toAiProposalView(doc));
  });

  app.post(
    '/ai/proposals/:id/retry',
    { config: { rateLimit: AI_PROPOSAL_LIMIT }, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const owned = await loadOwnedProposal(id, request.authUser?.sub ?? '');
      const doc = await AiProposal.findOneAndUpdate(
        { _id: owned._id, status: 'failed' },
        {
          $set: {
            status: 'generating',
            stage: 'queued',
            error: null,
            rawOutput: null,
            result: null,
            durationMs: null,
            geminiCalls: 0,
          },
          $inc: { runs: 1 },
        },
        { new: true },
      );
      if (!doc) {
        return conflict(reply, owned, 'Only a failed proposal can be retried.');
      }
      await enqueueOrFail(doc);
      return reply.status(202).send(toAiProposalView(doc));
    },
  );

  app.post('/ai/proposals/:id/cancel', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await loadOwnedProposal(id, request.authUser?.sub ?? '');
    const doc = await AiProposal.findOneAndUpdate(
      { _id: owned._id, status: { $in: ['generating', 'ready'] } },
      { $set: { status: 'cancelled', stage: null } },
      { new: true },
    );
    if (!doc) {
      return conflict(reply, owned, 'This proposal can no longer be cancelled.');
    }
    return reply.send(toAiProposalView(doc));
  });

  app.post(
    '/ai/proposals/:id/commit',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...KINDS] },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', pattern: SLUG_PATTERN.source, maxLength: SLUG_MAX_LENGTH },
            description: { type: 'string', maxLength: 500 },
            // `authentication` is deliberately not accepted in SP1. The auth question arrives
            // in Sub-project 2, which must also add this file to ALLOWED in
            // packages/ips/src/auth-invariants.test.ts.
            blueprint: {
              type: 'object',
              required: ['entities'],
              properties: { entities: { type: 'array' } },
            },
          },
        },
      },
      // A commit with no body is the ordinary case; see drafts.ts for why this is needed.
      preValidation: (request, _reply, done) => {
        request.body ??= {};
        // Unlike the other routes, which silently strip unknown fields (Fastify's ajv
        // removeAdditional), this one rejects `authentication` outright. The field decides who
        // can read a project, and SP2 reintroduces it deliberately; until then a client that
        // sends it must hear that it was not applied rather than assume it was.
        const body = request.body;
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
          if ('authentication' in body) {
            done(
              new AppError({
                code: 'VALIDATION_ERROR',
                message: 'authentication is not accepted on AI proposal commit yet',
                details: [
                  {
                    path: 'authentication',
                    issue: 'not accepted until the authentication step ships (Sub-project 2)',
                  },
                ],
              }),
            );
            return;
          }
        }
        done();
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as CommitBody;
      const sub = request.authUser?.sub ?? '';
      const owned = await loadOwnedProposal(id, sub);

      if (body.slug !== undefined && !isUsableSlug(body.slug)) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: `slug '${body.slug}' is reserved or malformed`,
          details: [{ path: 'slug', issue: 'must be kebab-case and not a reserved word' }],
        });
      }

      await assertProjectQuota(sub, request.authUser?.plan);

      // The claim is the double-commit guard: only one request can move
      // ready → committing; the loser sees the new status and gets a 409.
      const claimed = await AiProposal.findOneAndUpdate(
        { _id: owned._id, status: 'ready', result: { $ne: null } },
        { $set: { status: 'committing' } },
        { new: true },
      );
      if (!claimed || !claimed.result) {
        const current = (await AiProposal.findById(owned._id)) ?? owned;
        return conflict(
          reply,
          current,
          current.status === 'committed'
            ? 'This proposal was already used to create a project.'
            : 'This proposal is not ready to commit.',
        );
      }

      // Captured so the failure path can tell whether the project was persisted.
      let createdId: string | null = null;
      try {
        const result = claimed.result;
        const shape = toBuilderShape(
          body.blueprint ?? {
            entities: result.entities,
            generationConfig: result.generationConfig,
          },
          newProjectGenerationConfig(config.defaultMockRecords),
        );
        const kind = body.kind ?? claimed.hints?.kind ?? result.recommendedKind;
        const name = body.name?.trim() || result.name;
        const raw = JSON.stringify({
          entities: shape.entities,
          generationConfig: shape.generationConfig,
        });

        const created = await createProjectRecord({
          ownerId: sub,
          prepare: (projectId) => {
            createdId = projectId;
            return {
              name,
              kind,
              slug: body.slug ?? null,
              // Project.description has maxlength 500; a 1000-char prompt fallback would 500 on save.
              description: (body.description ?? (result.description || claimed.prompt)).slice(
                0,
                500,
              ),
              inputSource: { type: 'builder', raw },
              ips: parseInputSource(projectId, name, 'builder', raw, config, kind),
            };
          },
        });

        await AiProposal.updateOne(
          { _id: claimed._id, status: 'committing' },
          { $set: { status: 'committed', projectId: created._id, committedAt: new Date() } },
        );
        return reply.status(201).send(toProjectDetail(created));
      } catch (error) {
        // A duplicate project is worse than a 500 for a commit that actually
        // succeeded: if the project was persisted (the failure came after the
        // save, e.g. the 'committed' write blipped), settle as committed rather
        // than reverting to 'ready', which would let the next commit duplicate it.
        const persisted =
          createdId !== null && (await Project.exists({ _id: createdId }).catch(() => null));
        if (persisted) {
          try {
            await AiProposal.updateOne(
              { _id: claimed._id, status: 'committing' },
              { $set: { status: 'committed', projectId: createdId, committedAt: new Date() } },
            );
          } catch (settleError) {
            logger.error('Could not settle committed AI proposal', {
              proposalId: String(claimed._id),
              error: getErrorMessage(settleError),
            });
          }
        } else {
          await AiProposal.updateOne(
            { _id: claimed._id, status: 'committing' },
            { $set: { status: 'ready' } },
          );
        }
        throw error;
      }
    },
  );
};

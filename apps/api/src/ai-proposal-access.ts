/**
 * Helpers shared by the AI proposal routes (SP1 propose/poll/commit and SP2
 * review): budget, owner-scoped loading, lazy expiry and the 409 shape.
 */

import type { FastifyReply } from 'fastify';
import { AppError, getErrorMessage, logger } from '@instantmockapi/shared';
import { enqueueAiProposalJob } from '@instantmockapi/queue';
import { AiProposal, mongoose, type IAiProposal } from '@instantmockapi/db';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  PROMPT_IMAGE_TYPES,
  checkPromptImages,
  type PromptImage,
} from '@instantmockapi/ai';

/**
 * Burst guard only. The plugin's counter is per route and per instance (and
 * resets on a restart), so on its own it cannot enforce an hourly budget; the
 * Mongo-backed `assertProposalBudget` below is the real, shared limit.
 */
export const AI_PROPOSAL_LIMIT = { max: 20, timeWindow: 60 * 60_000 };

/** Model runs per user per hour. Each run costs one or two model calls, so this is a cost guard. */
export const AI_RUNS_PER_HOUR = 20;

/** A job cannot legitimately run this long; past it, the proposal was lost (e.g. Redis restarted). */
export const STUCK_AFTER_MS = 10 * 60_000;

export const KINDS = ['project', 'single'] as const;
export type ProposalKindInput = (typeof KINDS)[number];

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', maxLength: 64 } },
} as const;

export function notFound(): AppError {
  return new AppError({ code: 'NOT_FOUND', message: 'Proposal not found' });
}

/**
 * Refuse when the owner has already started `AI_RUNS_PER_HOUR` runs in the last
 * hour. Counts `runs` + `translations` (retries included) over proposals whose current run
 * started in the window, so creating, retrying and translating share one budget across all
 * instances.
 */
export async function assertProposalBudget(ownerId: string): Promise<void> {
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const [usage] = await AiProposal.aggregate<{ runs: number }>([
    { $match: { ownerId: new mongoose.Types.ObjectId(ownerId), runStartedAt: { $gte: hourAgo } } },
    {
      $group: { _id: null, runs: { $sum: { $add: ['$runs', { $ifNull: ['$translations', 0] }] } } },
    },
  ]);
  if ((usage?.runs ?? 0) >= AI_RUNS_PER_HOUR) {
    throw new AppError({
      code: 'RATE_LIMIT_EXCEEDED',
      message: `You have reached the limit of ${AI_RUNS_PER_HOUR} AI generations per hour. Please try again later.`,
    });
  }
}

export async function loadOwnedProposal(id: string, ownerId: string): Promise<IAiProposal> {
  if (!mongoose.isValidObjectId(id)) {
    throw notFound();
  }
  const doc = await AiProposal.findOne({ _id: id, ownerId });
  if (!doc) {
    throw notFound();
  }
  return doc;
}

/**
 * Request size for the routes that take images: three at the per-image cap,
 * base64-encoded, plus the text. The global limit (1 MB) stays for every
 * other route.
 */
export const IMAGE_BODY_LIMIT = Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3) + 64_000;

/** Body schema for `images`. Types and bytes are checked again by `checkPromptImages`. */
export const IMAGES_SCHEMA = {
  type: 'array',
  maxItems: MAX_IMAGES,
  items: {
    type: 'object',
    required: ['mimeType', 'data'],
    additionalProperties: false,
    properties: {
      mimeType: { type: 'string', enum: [...PROMPT_IMAGE_TYPES] },
      data: { type: 'string', minLength: 1 },
    },
  },
} as const;

/**
 * The text and images of a request. Either may be missing, not both. A
 * photo-only request is stored with `whenImageOnly` as its prompt, so history
 * and the model both have a sentence to read.
 */
export function readPromptInput(
  body: { prompt?: string; images?: { mimeType: string; data: string }[] },
  messages: { blank: string; whenImageOnly: string },
): { prompt: string; images: PromptImage[] } {
  const checked = checkPromptImages(body.images ?? []);
  if (!checked.ok) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: `The image ${checked.issue}.`,
      details: [{ path: checked.path, issue: checked.issue }],
    });
  }
  const prompt = body.prompt?.trim() ?? '';
  if (!prompt && checked.images.length === 0) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: messages.blank,
      details: [{ path: 'prompt', issue: 'must not be blank' }],
    });
  }
  return { prompt: prompt || messages.whenImageOnly, images: checked.images };
}

/**
 * Load a proposal for a route that only makes sense for a new project:
 * commit, and the review routes that edit, regenerate, adopt or translate it.
 *
 * A proposal that edits an existing project is applied in that project's
 * editor; committing one would create a second project from a partial copy of
 * the first.
 */
export async function loadOwnedNewProjectProposal(
  id: string,
  ownerId: string,
): Promise<IAiProposal> {
  const doc = await loadOwnedProposal(id, ownerId);
  if (doc.editsProjectId) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: "This suggestion edits an existing project. Apply it in that project's editor.",
      details: [{ path: 'id', issue: 'edits an existing project' }],
    });
  }
  return doc;
}

/**
 * Queue the job, or settle the proposal as failed and answer 503. The prompt
 * stays in history either way, so the user can retry without retyping. The
 * cause (e.g. a Redis error) is logged, never sent to the client.
 */
export async function enqueueProposalOrFail(doc: IAiProposal): Promise<void> {
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

/** Project creation is a handful of writes; past this, the request that claimed it is gone. */
export const COMMIT_STUCK_AFTER_MS = 2 * 60_000;

/** Lazy expiry: settle a lost job on read instead of running a sweeper. */
export async function expireIfStuck(doc: IAiProposal): Promise<IAiProposal> {
  if (doc.status === 'committing') {
    if (doc.updatedAt.getTime() > Date.now() - COMMIT_STUCK_AFTER_MS) {
      return doc;
    }
    // Goes to `failed`, not back to `ready`: no project id is recorded before the
    // save, so we cannot tell whether the project exists, and `ready` would let a
    // second commit create a duplicate. `failed` allows a retry or a new proposal
    // after the user has checked their projects list.
    const interrupted = await AiProposal.findOneAndUpdate(
      { _id: doc._id, status: 'committing', updatedAt: doc.updatedAt },
      {
        $set: {
          status: 'failed',
          stage: null,
          error: {
            code: 'AI_GENERATION_FAILED',
            message:
              'Project creation was interrupted. Check your projects list before trying again.',
            details: [],
          },
        },
      },
      { new: true },
    );
    return interrupted ?? (await AiProposal.findById(doc._id)) ?? doc;
  }
  if (
    doc.status === 'ready' &&
    doc.translation?.status === 'pending' &&
    (doc.translation.requestedAt ?? doc.updatedAt).getTime() <= Date.now() - STUCK_AFTER_MS
  ) {
    // Own clock, not updatedAt: every draft autosave bumps updatedAt, which would
    // postpone expiry indefinitely. The language guards against a newer request.
    const expired = await AiProposal.findOneAndUpdate(
      {
        _id: doc._id,
        status: 'ready',
        'translation.status': 'pending',
        'translation.language': doc.translation.language,
      },
      {
        $set: {
          translation: {
            status: 'failed',
            language: doc.translation.language,
            message: 'Translation timed out. Please retry.',
          },
        },
      },
      { new: true },
    );
    return expired ?? (await AiProposal.findById(doc._id)) ?? doc;
  }
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

export function conflict(reply: FastifyReply, doc: IAiProposal, message: string) {
  return reply.status(409).send({
    error: {
      code: 'CONFLICT',
      message,
      status: doc.status,
      ...(doc.projectId ? { projectId: String(doc.projectId) } : {}),
      ...(doc.childId ? { childId: String(doc.childId) } : {}),
    },
  });
}

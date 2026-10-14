import { logger } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
// `mongoose` is not a dependency of apps/workers; use the instance the db package re-exports.
import { AI_PROPOSAL_RAW_OUTPUT_MAX, AiProposal, mongoose } from '@instantmockapi/db';
import { newProjectGenerationConfig } from '@instantmockapi/ips';
import {
  GeminiProvider,
  PROMPT_VERSION,
  proposeBlueprint,
  type AiFailure,
  type LLMProvider,
} from '@instantmockapi/ai';
import type { AiProposalJobPayload } from '@instantmockapi/queue';

export interface AiProposalDeps {
  config?: EnvConfig;
  /** Injected in tests; built from config otherwise. */
  provider?: LLMProvider;
}

/**
 * Turn a `generating` proposal into `ready` or `failed`.
 *
 * Throws only for transient provider errors, so BullMQ's retry policy applies to
 * exactly those. Every final outcome is written here and the function returns —
 * a final failure thrown to BullMQ would be retried pointlessly, and its
 * exhaustion hook would overwrite the specific error with a generic one.
 *
 * Every write filters on `status: 'generating'`: if the user cancelled while
 * Gemini was thinking, the result is dropped rather than resurrecting the
 * proposal.
 */
export async function processAiProposalJob(
  payload: AiProposalJobPayload,
  deps: AiProposalDeps = {},
): Promise<void> {
  if (!mongoose.isValidObjectId(payload.proposalId)) {
    logger.warn('AI proposal job with a malformed id; dropping', {
      proposalId: payload.proposalId,
    });
    return;
  }
  const proposal = await AiProposal.findById(payload.proposalId).lean();
  // Gone (30-day TTL) or no longer generating (cancelled, or a duplicate run):
  // nothing to do, and throwing would only trigger pointless retries.
  if (!proposal || proposal.status !== 'generating') {
    return;
  }

  const config = deps.config ?? loadEnvConfig();
  const started = Date.now();
  const pending = { _id: proposal._id, status: 'generating' as const };

  if (!deps.provider && !config.geminiApiKey) {
    logger.error('AI proposal cannot run: GEMINI_API_KEY is not configured for the worker');
    await AiProposal.updateOne(pending, {
      $set: failedUpdate(
        { code: 'AI_NOT_CONFIGURED', message: 'The AI service is not configured.', details: [] },
        null,
        0,
        Date.now() - started,
      ),
    });
    return;
  }

  const provider =
    deps.provider ?? new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel });
  const outcome = await proposeBlueprint(
    {
      prompt: proposal.prompt,
      hints: {
        ...(proposal.hints?.name ? { name: proposal.hints.name } : {}),
        ...(proposal.hints?.description ? { description: proposal.hints.description } : {}),
        ...(proposal.hints?.kind ? { kind: proposal.hints.kind } : {}),
      },
      responseLanguage: proposal.responseLanguage,
    },
    {
      provider,
      generationDefaults: newProjectGenerationConfig(config.defaultMockRecords),
      maxDepth: config.maxNestingDepth,
      onStage: async (stage) => {
        await AiProposal.updateOne(pending, { $set: { stage } });
      },
    },
  );

  const durationMs = Date.now() - started;
  const provenance = { model: provider.model, promptVersion: PROMPT_VERSION };
  if (outcome.ok) {
    await AiProposal.updateOne(pending, {
      $set: {
        status: 'ready',
        stage: null,
        result: outcome.output,
        error: null,
        rawOutput: null,
        geminiCalls: outcome.geminiCalls,
        durationMs,
        ...provenance,
      },
    });
    return;
  }
  if (outcome.failure.code === 'AI_NOT_CONFIGURED') {
    logger.error('AI provider rejected the configured key or model', { model: provider.model });
  }
  await AiProposal.updateOne(pending, {
    $set: {
      ...failedUpdate(outcome.failure, outcome.rawOutput, outcome.geminiCalls, durationMs),
      ...provenance,
    },
  });
}

function failedUpdate(
  failure: AiFailure,
  rawOutput: string | null,
  geminiCalls: number,
  durationMs: number,
) {
  return {
    status: 'failed',
    stage: null,
    result: null,
    error: failure,
    rawOutput: rawOutput === null ? null : rawOutput.slice(0, AI_PROPOSAL_RAW_OUTPUT_MAX),
    geminiCalls,
    durationMs,
  };
}

/**
 * BullMQ spent every retry on transient errors. Settle the proposal so the UI
 * stops polling and offers Retry; a proposal already settled is left alone.
 */
export async function settleExhaustedAiProposal(
  payload: AiProposalJobPayload,
  error: Error,
): Promise<void> {
  logger.warn('AI proposal exhausted its retries', {
    proposalId: payload.proposalId,
    error: error.message,
  });
  if (!mongoose.isValidObjectId(payload.proposalId)) {
    return;
  }
  await AiProposal.updateOne(
    { _id: payload.proposalId, status: 'generating' },
    {
      $set: {
        status: 'failed',
        stage: null,
        error: {
          code: 'AI_GENERATION_FAILED',
          message: 'The AI service is busy. Please try again in a minute.',
          details: [],
        },
      },
    },
  );
}

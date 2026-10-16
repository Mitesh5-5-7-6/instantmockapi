/**
 * Write a project's Docs guide (see `ProjectGuide`).
 *
 * Runs on the AI queue beside proposals. Every write filters on the run it was
 * queued for, so a regeneration that started meanwhile wins over a late result.
 */

import { logger } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { ProjectGuide, mongoose } from '@instantmockapi/db';
import {
  GUIDE_PROMPT_VERSION,
  GeminiProvider,
  writeGuide,
  type LLMProvider,
} from '@instantmockapi/ai';
import type { AiProposalJobPayload } from '@instantmockapi/queue';

export interface AiGuideDeps {
  config?: EnvConfig;
  provider?: LLMProvider;
}

export async function processAiGuideJob(
  payload: AiProposalJobPayload,
  deps: AiGuideDeps = {},
): Promise<void> {
  const guide = await ProjectGuide.findById(payload.proposalId).lean();
  if (!guide || guide.status !== 'generating' || guide.runs !== payload.run) {
    return;
  }
  const pending = { _id: guide._id, status: 'generating' as const, runs: payload.run };
  const config = deps.config ?? loadEnvConfig();
  if (!deps.provider && !config.geminiApiKey) {
    logger.error('AI guide cannot run: GEMINI_API_KEY is not configured for the worker');
    await ProjectGuide.updateOne(pending, {
      $set: {
        status: 'failed',
        error: { code: 'AI_NOT_CONFIGURED', message: 'The AI service is not configured.' },
      },
    });
    return;
  }
  const provider =
    deps.provider ?? new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel });

  // A transient provider error propagates, so BullMQ retries it.
  const outcome = await writeGuide(
    { context: guide.context, endpoints: guide.endpoints },
    { provider },
  );
  const provenance = {
    aiModel: provider.model,
    promptVersion: GUIDE_PROMPT_VERSION,
    geminiCalls: outcome.geminiCalls,
  };
  await ProjectGuide.updateOne(pending, {
    $set: outcome.ok
      ? { status: 'ready', markdown: outcome.markdown, error: null, ...provenance }
      : {
          status: 'failed',
          markdown: null,
          error: { code: outcome.failure.code, message: outcome.failure.message },
          ...provenance,
        },
  });
}

/** Retries spent on transient errors: settle, so the Docs tab stops waiting. */
export async function settleExhaustedAiGuide(payload: AiProposalJobPayload): Promise<void> {
  if (!mongoose.isValidObjectId(payload.proposalId)) {
    return;
  }
  await ProjectGuide.updateOne(
    { _id: payload.proposalId, status: 'generating', runs: payload.run },
    {
      $set: {
        status: 'failed',
        error: {
          code: 'AI_GENERATION_FAILED',
          message: 'The AI service is busy. Please try again in a minute.',
        },
      },
    },
  );
}

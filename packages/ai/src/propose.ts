import type { ErrorDetail } from '@instantmockapi/shared';
import type { GenerationConfig } from '@instantmockapi/ips';
import { buildRepairTurn, buildUserTurn, SYSTEM_PROMPT } from './prompt.js';
import { ProviderError, type LLMProvider, type LLMTurn } from './provider.js';
import { fallbackProjectName, isRecord, parseModelJson, sanitizeMeta } from './sanitize.js';
import { toBuilderShape, validateShape } from './shape.js';
import type { AiFailure, AiProposalOutput, ProposeInput } from './types.js';

export type ProposalStage = 'generating' | 'repairing' | 'validating';

export interface ProposeDeps {
  provider: LLMProvider;
  generationDefaults: GenerationConfig;
  maxDepth: number;
  /** Platform cap on mockRecords; larger model-proposed counts are coerced to the default. */
  maxMockRecords?: number;
  /** Curated reference blueprints. Always empty in Sub-project 1; Sub-project 3 fills it. */
  examples?: readonly unknown[];
  /** Progress callback for the UI. A rejection here propagates. */
  onStage?: (stage: ProposalStage) => Promise<void>;
}

export type ProposeOutcome =
  | { ok: true; output: AiProposalOutput; geminiCalls: number }
  | { ok: false; failure: AiFailure; rawOutput: string | null; geminiCalls: number };

/** One initial call plus one repair (spec §6: bounded). */
const MAX_CALLS = 2;
/** The previous answer is echoed back on repair; cap it so a runaway response cannot balloon the prompt. */
const ECHO_MAX = 64_000;

const INVALID_MESSAGE =
  'The AI produced a schema that failed validation. Try rephrasing your request.';

/**
 * Generate → validate → (at most one) repair.
 *
 * Final failures come back as `{ ok: false }`. A transient provider error is
 * rethrown instead, because only the queue knows whether retries remain.
 */
export async function proposeBlueprint(
  input: ProposeInput,
  deps: ProposeDeps,
): Promise<ProposeOutcome> {
  const turns: LLMTurn[] = [{ role: 'user', text: buildUserTurn(input, deps.examples ?? []) }];
  let lastText: string | null = null;
  let lastDetails: ErrorDetail[] = [];

  for (let call = 1; call <= MAX_CALLS; call += 1) {
    await deps.onStage?.(call === 1 ? 'generating' : 'repairing');

    let text: string;
    try {
      text = await deps.provider.generate({ system: SYSTEM_PROMPT, turns });
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'config') {
        return fail(
          {
            code: 'AI_NOT_CONFIGURED',
            message: 'The AI service is not configured correctly.',
            details: [],
          },
          lastText,
          call,
        );
      }
      if (error instanceof ProviderError && error.kind === 'blocked') {
        return fail(
          {
            code: 'AI_GENERATION_FAILED',
            message: 'The request was blocked by the AI provider.',
            details: [],
          },
          lastText,
          call,
        );
      }
      throw error;
    }

    await deps.onStage?.('validating');
    lastText = text;
    const evaluated = evaluate(text, input, deps);
    if (evaluated.ok) {
      return { ok: true, output: evaluated.output, geminiCalls: call };
    }
    lastDetails = evaluated.details;
    turns.push(
      { role: 'model', text: text.slice(0, ECHO_MAX) },
      { role: 'user', text: buildRepairTurn(lastDetails) },
    );
  }

  return fail(
    { code: 'AI_GENERATION_FAILED', message: INVALID_MESSAGE, details: lastDetails },
    lastText,
    MAX_CALLS,
  );
}

function fail(failure: AiFailure, rawOutput: string | null, geminiCalls: number): ProposeOutcome {
  return { ok: false, failure, rawOutput, geminiCalls };
}

function evaluate(
  text: string,
  input: ProposeInput,
  deps: ProposeDeps,
): { ok: true; output: AiProposalOutput } | { ok: false; details: ErrorDetail[] } {
  let raw: unknown;
  try {
    raw = parseModelJson(text);
  } catch {
    return { ok: false, details: [{ path: '', issue: 'The response was not a JSON object' }] };
  }
  if (!isRecord(raw)) {
    return { ok: false, details: [{ path: '', issue: 'The response was not a JSON object' }] };
  }

  const meta = sanitizeMeta(raw);
  const shape = toBuilderShape(
    raw,
    deps.generationDefaults,
    deps.maxMockRecords === undefined ? undefined : { maxMockRecords: deps.maxMockRecords },
  );
  const details = validateShape(shape, input.hints.kind ?? meta.recommendedKind, deps.maxDepth);
  if (details.length > 0) {
    return { ok: false, details };
  }

  return {
    ok: true,
    output: {
      ...meta,
      name: input.hints.name?.trim() || meta.name || fallbackProjectName(input.prompt),
      entities: shape.entities,
      generationConfig: shape.generationConfig,
    },
  };
}

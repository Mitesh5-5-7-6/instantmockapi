import type { PromptImage } from './images.js';
import type { ErrorDetail } from '@instantmockapi/shared';
import type { Entity, GenerationConfig } from '@instantmockapi/ips';

/** The two kinds an AI proposal may recommend. `auth` has no entities, so the AI never proposes it. */
export type ProposalKind = 'project' | 'single';

/** Everything in a proposal except the schema itself — already sanitized. */
export interface ProposalMeta {
  /** BCP-47 primary tag of the prompt, or `und` when the model gave nothing usable. */
  detectedLanguage: string;
  /** Short English label, e.g. "event volunteer scheduling". Sub-project 3's retrieval key. */
  domain: string;
  recommendedKind: ProposalKind;
  kindRationale: string;
  /** English display name; the slug and public URL derive from it. */
  name: string;
  description: string;
  /** Advisory only. Nothing reads this to enable authentication. */
  authRecommendation: { recommended: boolean; reason: string };
  assumptions: string[];
  questions: string[];
}

/** A proposal that passed IPS validation. */
export interface AiProposalOutput extends ProposalMeta {
  entities: Entity[];
  generationConfig: GenerationConfig;
}

export type AiFailureCode = 'AI_NOT_CONFIGURED' | 'AI_GENERATION_FAILED';

export interface AiFailure {
  code: AiFailureCode;
  message: string;
  details: ErrorDetail[];
}

export interface ProposeInput {
  prompt: string;
  hints: { name?: string; kind?: ProposalKind; description?: string };
  /** BCP-47 tag the prose should be written in; null means "same as the prompt". */
  responseLanguage: string | null;
  /** Regenerate only: the user's answers to the AI's questions and/or an extra instruction. */
  clarification?: { answers?: string; instruction?: string } | null;
  /** Regenerate only: the blueprint being revised (the parent's draft entities, or its result's). */
  currentBlueprint?: readonly unknown[] | null;
  /** Photos or screenshots describing the data, already validated by `checkPromptImages`. */
  images?: readonly PromptImage[];
}

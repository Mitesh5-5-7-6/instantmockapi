import { Schema, model, Document, Types } from 'mongoose';
import type { ErrorCode, ErrorDetail } from '@instantmockapi/shared';
import type { AiProposalOutput, ProposalKind } from '@instantmockapi/ai';

/**
 * One AI request, from prompt to committed project (Phase 7, Sub-project 1).
 *
 * **Operational, not research data.** It exists so the user can leave the page,
 * come back, retry, see their prompt history, and commit exactly once. It is
 * owner-scoped and expires; Sub-project 3 keeps its own consent-gated records
 * for learning, and must not repurpose this collection.
 *
 * ## Status machine
 *
 *     generating ──▶ ready ──▶ committing ──▶ committed
 *         │            │            │
 *         ▼            ▼            └──(create failed)──▶ ready
 *       failed      cancelled
 *         │
 *         └──retry──▶ generating
 *
 * Every transition is a conditional update with the expected current status in
 * its filter. That is what stops a cancelled proposal receiving a late worker
 * result, and a double-clicked commit creating two projects.
 */
export type AiProposalStatus =
  'generating' | 'ready' | 'failed' | 'cancelled' | 'committing' | 'committed';

/** Progress inside `generating`, so the UI can say something truer than "loading". Null otherwise. */
export type AiProposalStage = 'queued' | 'generating' | 'repairing' | 'validating';

/** 30 days: long enough to be useful as prompt history; the project itself is permanent. */
export const AI_PROPOSAL_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Raw model text is kept only on failure, for debugging, and bounded. */
export const AI_PROPOSAL_RAW_OUTPUT_MAX = 64_000;

// `model` is the Gemini model id the brief requires, but Document already has a
// `model()` method with an incompatible type, so that one member is omitted.
export interface IAiProposal extends Omit<Document, 'model'> {
  ownerId: Types.ObjectId;
  status: AiProposalStatus;
  stage: AiProposalStage | null;
  /** As typed, ≤ 1000 chars. The owner's own data, used only to serve them. */
  prompt: string;
  hints: { name?: string; kind?: ProposalKind; description?: string };
  responseLanguage: string | null;
  /** Set only once the proposal passed IPS validation. */
  result: AiProposalOutput | null;
  error: { code: ErrorCode; message: string; details: ErrorDetail[] } | null;
  rawOutput: string | null;
  model: string;
  promptVersion: string;
  /** 2 means a repair happened. */
  geminiCalls: number;
  durationMs: number | null;
  /**
   * How many times this proposal has been queued. Part of the BullMQ job id:
   * failed jobs stay in Redis, and re-adding an existing id is a silent no-op,
   * so a retry needs a fresh id.
   */
  runs: number;
  /**
   * When the current run was queued: creation time, reset on every retry. The
   * hourly cost budget sums `runs` over proposals whose run started in the
   * last hour; keyed on `createdAt` alone, retrying an old proposal would cost
   * model calls without ever counting against the budget.
   */
  runStartedAt: Date;
  projectId: Types.ObjectId | null;
  committedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiProposalSchema = new Schema<IAiProposal>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // No `enum` validators on status/stage: every write is a conditional update
    // from typed code, and a validator would not run on updateOne anyway.
    status: { type: String, required: true, default: 'generating' },
    stage: { type: String, default: 'queued' },
    prompt: { type: String, required: true, maxlength: 1000 },
    hints: {
      name: { type: String },
      kind: { type: String },
      description: { type: String },
    },
    responseLanguage: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    rawOutput: { type: String, default: null, maxlength: AI_PROPOSAL_RAW_OUTPUT_MAX },
    model: { type: String, required: true },
    promptVersion: { type: String, required: true },
    geminiCalls: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    runs: { type: Number, default: 1 },
    runStartedAt: { type: Date, default: () => new Date() },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    committedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// Prompt history: one owner, newest first. Equality field before the sort field.
aiProposalSchema.index({ ownerId: 1, createdAt: -1 });

// Hourly budget check: one owner, recent runs.
aiProposalSchema.index({ ownerId: 1, runStartedAt: -1 });

// TTL. Must stay single-field and separate from the index above — a TTL index
// cannot be compound, so "consolidating" the two would silently disable expiry.
aiProposalSchema.index({ createdAt: 1 }, { expireAfterSeconds: AI_PROPOSAL_TTL_SECONDS });

export const AiProposal = model<IAiProposal>('AiProposal', aiProposalSchema);

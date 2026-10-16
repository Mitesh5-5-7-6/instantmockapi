import { Schema, model, Document, Types } from 'mongoose';
import type { ErrorCode, ErrorDetail } from '@instantmockapi/shared';
import type { AiProposalOutput, PromptImage, ProposalKind } from '@instantmockapi/ai';
import type { AuthConfig, Entity } from '@instantmockapi/ips';

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
 *     ready ──adopt(child)──▶ superseded   (final; the child carries on)
 *
 * Every transition is a conditional update with the expected current status in
 * its filter. That is what stops a cancelled proposal receiving a late worker
 * result, and a double-clicked commit creating two projects.
 */
export type AiProposalStatus =
  'generating' | 'ready' | 'failed' | 'cancelled' | 'committing' | 'committed' | 'superseded';

/** Progress inside `generating`, so the UI can say something truer than "loading". Null otherwise. */
export type AiProposalStage = 'queued' | 'generating' | 'repairing' | 'validating';

/** 30 days: long enough to be useful as prompt history; the project itself is permanent. */
export const AI_PROPOSAL_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Raw model text is kept only on failure, for debugging, and bounded. */
export const AI_PROPOSAL_RAW_OUTPUT_MAX = 64_000;

/**
 * The user's edited copy of a proposal, kept beside `result` so the model's
 * original output stays intact for comparison and regeneration.
 */
export interface ProposalDraft {
  /**
   * Optimistic concurrency between tabs: a save must name the revision it was
   * based on, so a stale tab cannot silently overwrite a newer edit.
   */
  revision: number;
  kind: ProposalKind;
  name: string;
  description: string;
  entities: Entity[];
  generationConfig: { methods: string[]; mockRecords: number };
  /**
   * True once the user has answered the authentication question. The proposal
   * always asks, so "no answer yet" must be distinguishable from "no auth".
   */
  authAnswered: boolean;
  /** Null means "no authentication" once `authAnswered` is true; before that it means unanswered. */
  authentication: AuthConfig | null;
  savedAt: Date;
}

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
  /** The user's edits; null until the first save. `result` is never mutated by edits. */
  draft: ProposalDraft | null;
  /**
   * In-flight or failed prose translation. Null when idle; a successful
   * translation is written into `result` and clears this, so only the
   * states that need the UI's attention are stored. `requestedAt` is the
   * translation's own clock: lazy expiry measures from it, because draft
   * autosaves keep bumping `updatedAt`.
   */
  translation: {
    status: 'pending' | 'failed';
    language: string;
    message?: string;
    requestedAt?: Date;
  } | null;
  /** The proposal this one was regenerated from, so the chain can be walked back. */
  parentId: Types.ObjectId | null;
  /**
   * The latest regeneration of this proposal (set on every regenerate; the parent
   * is superseded only when it is adopted).
   */
  childId: Types.ObjectId | null;
  /** What the user told the model when regenerating: answers to its questions and/or a free instruction. */
  clarification: { answers?: string; instruction?: string } | null;
  /**
   * How many translations have been requested. Part of the translate job id
   * (`-t<n>`), for the same reason as `runs`: a retried translation must be
   * a new job, not a silent no-op against a failed one still in Redis.
   */
  translations: number;
  projectId: Types.ObjectId | null;
  /**
   * Set when this proposal edits an existing project instead of creating one.
   * Its result is applied to that project's draft in the editor; it can never be
   * committed as a new project. Distinct from `projectId`, which is the project a
   * proposal *created*.
   */
  editsProjectId: Types.ObjectId | null;
  /**
   * Photos or screenshots sent with the prompt, kept so a retry does not need
   * them again and deleted with the proposal by its TTL. **Not selected by
   * default** (`select: false`): a status poll must not load megabytes. Only the
   * worker reads them, with `.select('+images')`.
   */
  images?: PromptImage[];
  /** How many images came with the prompt; readable without loading them. */
  imageCount: number;
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
    draft: { type: Schema.Types.Mixed, default: null },
    translation: { type: Schema.Types.Mixed, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: 'AiProposal', default: null },
    childId: { type: Schema.Types.ObjectId, ref: 'AiProposal', default: null },
    clarification: { type: Schema.Types.Mixed, default: null },
    translations: { type: Number, default: 0 },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    editsProjectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    images: {
      type: [{ _id: false, mimeType: String, data: String }],
      default: undefined,
      select: false,
    },
    imageCount: { type: Number, default: 0 },
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

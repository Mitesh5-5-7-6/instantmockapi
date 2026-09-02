import { Schema, model, Document, Types } from 'mongoose';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

/**
 * The editable copy of a project's definition (Phase 1).
 *
 * ## Why a separate document rather than editing `Project.ips`
 *
 * "Do not directly modify the active generated project while the user is
 * editing." Every generator, the hosted runtime's config, the mock data and the
 * endpoint surface are all projections of `Project.ips`. Editing it in place
 * means a half-finished thought is the definition of record — and until Phase 2
 * lands regeneration, it would be a definition with no artifacts behind it.
 *
 * So the flow is:
 *
 *     ACTIVE DEFINITION ──fork──▶ DRAFT ──edit──▶ diff ──▶ impact ──▶ commit
 *          (untouched)                                                  │
 *          ◀───────────────── becomes the new definition ───────────────┘
 *
 * Commit is *not* publish. It advances the definition and leaves the project
 * pending regeneration; the live runtime keeps serving its own version until a
 * generation actually completes (see `published-version.ts`).
 *
 * ## One draft per project
 *
 * Enforced by a unique index rather than by convention. Phase 1 exists because
 * "a user discovers a mistake and fixes it" — that is one edit session, not a
 * branching model. Multiple concurrent drafts would need a draft picker in every
 * request, and would make "is this project pending regeneration" ambiguous.
 * History is Phase 2's job, and `Version` already holds it.
 */
export interface IProjectDraft extends Document {
  projectId: Types.ObjectId;
  /** The edited schema. Starts as a copy of `Project.ips`. */
  ips: InternalProjectSchema;
  /** The edited generation config. Starts as a copy of the project's. */
  generationConfig: GenerationConfig;
  /**
   * The definition version this draft was forked from.
   *
   * Load-bearing for correctness, not bookkeeping. The diff is only meaningful
   * against the baseline the user actually started from — and the active
   * definition can move underneath an open draft (a restore, a generate, another
   * tab). When `baseVersion` no longer matches `project.currentVersion` the draft
   * is stale, and showing its diff would describe changes against a definition
   * that no longer exists.
   */
  baseVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const projectDraftSchema = new Schema<IProjectDraft>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      // One draft per project, enforced by the database. A second `POST /draft`
      // therefore fails loudly rather than quietly creating a rival definition.
      unique: true,
    },
    ips: {
      type: Schema.Types.Mixed,
      required: true,
    },
    generationConfig: {
      type: Schema.Types.Mixed,
      required: true,
    },
    baseVersion: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
    // Same reason as the Version snapshot: an IPS is full of deliberately empty
    // objects (`validation: {}`, `meta: {}`), and mongoose would strip them,
    // making a round-tripped draft differ from its source for no reason — which
    // the diff would then report as a change the user never made.
    minimize: false,
  },
);

// The unique index comes from `unique: true` on the path; declaring it again here
// would create a duplicate definition and make index syncing nondeterministic.

export const ProjectDraft = model<IProjectDraft>('ProjectDraft', projectDraftSchema);

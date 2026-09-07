import { Schema, model, Document, Types } from 'mongoose';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

/**
 * Why this version exists (Phase 2 §3).
 *
 * `REGENERATION` is the one worth explaining: it means the definition did not
 * change, only which artifacts were built from it. Distinguishing it from
 * `FEATURE` is what stops a history of "regenerated the OpenAPI three times"
 * reading like three schema edits.
 */
export const VERSION_CHANGE_TYPES = [
  'INITIAL',
  'FEATURE',
  'BREAKING',
  'ROLLBACK',
  'REGENERATION',
] as const;

export type VersionChangeType = (typeof VERSION_CHANGE_TYPES)[number];

/** §3's counts, for the history list's one-line summary. */
export interface VersionChangeSummary {
  entitiesAdded: number;
  entitiesRemoved: number;
  entitiesModified: number;
  fieldsAdded: number;
  fieldsRemoved: number;
  fieldsModified: number;
  relationsAdded: number;
  relationsRemoved: number;
  relationsModified: number;
  endpointsAdded: number;
  endpointsRemoved: number;
  endpointsModified: number;
}

export interface IVersion extends Document {
  projectId: Types.ObjectId;
  version: number;
  ipsSnapshot: InternalProjectSchema;
  configSnapshot: GenerationConfig;
  /** Human-readable reason this version was generated (doc 03 §7 history panel). */
  note?: string | null;

  /*
   * ── Phase 2 metadata ──
   *
   * All optional, so every row written before Phase 2 stays valid and readable.
   *
   * ## What is deliberately NOT here
   *
   * **No `status`.** A version's state — generating, ready, degraded, failed,
   * published — is a pure function of its `Artifact` rows plus the project's
   * published pointer, and `version-readiness.ts` already makes the argument
   * for the general case: *"a `Version.runtimeStatus` column would be a cache of
   * the artifact rows, and a cache that can drift from the thing it caches."*
   * `versionStatus()` in `@instantmockapi/shared` computes it instead.
   *
   * **No `ROLLED_BACK` status either.** §7's own example puts
   * `changeType = ROLLBACK` on the *new* version rather than a status on the old
   * one, which is right: the old version is untouched, and something newer
   * happened to exist.
   */

  /**
   * The version this one was derived from.
   *
   * Usually `version - 1`, but not always — nothing stops a version being
   * created from a restore of something much older, and §7 wants the lineage
   * recorded rather than inferred from arithmetic.
   */
  parentVersion?: number | null;
  changeType?: VersionChangeType;
  changeSummary?: VersionChangeSummary | null;
  /** The user who caused this version to exist. */
  createdBy?: Types.ObjectId | null;
  /**
   * When this version first became the published one.
   *
   * An **event**, not a cache of the artifact rows, so it does not violate the
   * derive-don't-store rule above — and it is the only way to answer §26's
   * "mark the previous published version as historical", or to give the activity
   * feed a publish event at all. `activity.ts` derives everything it shows from
   * collections; there is no event table to read this from.
   */
  publishedAt?: Date | null;
  /** For a `ROLLBACK`: the version whose definition was copied forward (§7). */
  rollbackSourceVersion?: number | null;

  createdAt: Date;
}

const versionSchema = new Schema<IVersion>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    version: {
      type: Number,
      required: true,
    },
    ipsSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    configSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    note: {
      type: String,
      default: null,
    },
    parentVersion: {
      type: Number,
      default: null,
    },
    changeType: {
      type: String,
      enum: [...VERSION_CHANGE_TYPES],
      // No default: absent means "written before Phase 2", which is a different
      // statement from "we know this was a FEATURE".
      required: false,
    },
    changeSummary: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    rollbackSourceVersion: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // snapshot is immutable
    // Keep empty objects in IPS snapshots (validation: {}, meta: {})
    minimize: false,
  },
);

// Indexes
versionSchema.index({ projectId: 1, version: -1 });

/**
 * One row per version, enforced.
 *
 * Uniqueness was only ever *implied* — by the `$setOnInsert` upsert in
 * `createGenerationJob` being the single writer. Phase 2 adds more writers (every
 * site that advances `currentVersion`), so the guarantee moves into the index
 * where a race cannot get around it.
 */
versionSchema.index({ projectId: 1, version: 1 }, { unique: true });

/** §29: the history list reads newest-first by time, not only by number. */
versionSchema.index({ projectId: 1, createdAt: -1 });

export const Version = model<IVersion>('Version', versionSchema);

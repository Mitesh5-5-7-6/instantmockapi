import { Schema, model, Document, Types } from 'mongoose';
import { PROJECT_KINDS, type ProjectKind } from '@instantmockapi/shared';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

export interface IProject extends Document {
  ownerId: Types.ObjectId;
  name: string;
  /** What this project generates. Absent on documents written before kinds. */
  kind?: ProjectKind;
  /**
   * Public routing id (`prj_`/`sng_` + hex) — **authoritative for hosted URL
   * resolution**. Null until minted, in which case only the legacy ObjectId URL
   * resolves.
   */
  publicId?: string | null;
  /**
   * Vanity path segment. Purely cosmetic: it is never matched during resolution,
   * so renaming it cannot break a URL anyone has already copied.
   */
  slug?: string | null;
  /** Free-text purpose, shown on the project page. Absent on older documents. */
  description?: string | null;
  status: 'draft' | 'generating' | 'active' | 'expired';
  inputSource: {
    type: 'json' | 'swagger' | 'builder' | 'docs';
    raw: string;
  };
  ips: InternalProjectSchema;
  /**
   * Version of the **definition** — the schema the user edits.
   *
   * Advances whenever the definition changes: a schema PATCH, a restore, a
   * regenerate. It is mirrored into `ips.version` and flows into artifact
   * *content* (the OpenAPI `info.version`, the Postman collection name, the
   * export README), so it describes what was authored, not what is live.
   *
   * **The hosted runtime must never resolve on this field.** Doing so is what
   * coupled editing to deployment: advancing it pointed the live URL at a
   * version whose artifacts did not exist yet, so a schema edit — or a
   * restore, which writes no artifacts at all — 404ed the API with no job
   * queued and no way to recover. `publishedVersion` is what the runtime reads.
   */
  currentVersion: number;
  /**
   * Version the hosted runtime **serves**.
   *
   * Advances only when a generation completes with a `hosted_api` artifact
   * actually written (see `settleJob` in apps/workers/src/processor.ts). Nothing
   * an editor does can move it, which is the whole invariant:
   *
   * > The runtime must only ever resolve a version whose artifact set is
   * > complete. Until publishing succeeds, the existing runtime is untouched.
   *
   * Absent on every project written before the split. Read it as
   * `publishedVersion ?? currentVersion`, which reproduces the old behaviour
   * exactly — so healthy projects serve what they served before, and a project
   * already skewed by the old bug stays skewed until its next generation heals
   * it. No backfill can invent artifacts that were never generated.
   *
   * `definitionVersion > publishedVersion` is the "pending regeneration"
   * signal the platform never had a way to express.
   */
  publishedVersion?: number | null;
  /**
   * Whether a successful generation may move `publishedVersion` on its own.
   *
   * Phase 2 §1 made publishing explicit, with one exception — a project with
   * nothing live. This opts a project into a second: **every** ready version
   * goes live the moment it generates.
   *
   * ## Why it lives here and not in `generationConfig`
   *
   * `generationConfig` is part of the versioned IPS, so a setting placed there
   * is diffed, risk-scored and shown in the compare view as a change to the
   * API. This is none of those things — it changes *when a human is asked*, not
   * what the API does. A caller cannot observe it. Putting it in the IPS would
   * also make toggling it a definition change that itself needs publishing,
   * which is a loop with no honest exit.
   *
   * Absent on every project written before it existed, and read as `false` —
   * the explicit step is what those projects have today.
   */
  autoPublish?: boolean;
  generationConfig: GenerationConfig;
  hosted: {
    url: string | null;
    expiresAt: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    kind: {
      type: String,
      // From `PROJECT_KINDS` rather than a second hardcoded list. The duplicate
      // is what made adding the `auth` kind fail here with a 500 after every
      // other layer had been updated — the shared constant is the one place a
      // new kind should have to be declared.
      enum: [...PROJECT_KINDS],
      default: 'project',
    },
    publicId: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    slug: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'generating', 'active', 'expired'],
      default: 'draft',
    },
    inputSource: {
      type: {
        type: String,
        required: true,
        enum: ['json', 'swagger', 'builder', 'docs'],
      },
      raw: {
        type: String,
        required: true,
      },
    },
    ips: {
      type: Schema.Types.Mixed, // The IPS carries a complex recursive structure
      required: true,
    },
    currentVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    publishedVersion: {
      type: Number,
      // Null, not 1: a brand-new project has generated nothing, so there is no
      // published version yet. Defaulting to 1 would claim the runtime is
      // serving a version whose artifacts do not exist — the exact confusion
      // this field exists to remove.
      default: null,
    },
    autoPublish: {
      type: Boolean,
      // False, not undefined: the explicit-publish step is the behaviour every
      // existing project has, and a missing field must keep meaning that.
      default: false,
    },
    generationConfig: {
      type: Schema.Types.Mixed, // GenerationConfig structure
      required: true,
    },
    hosted: {
      url: {
        type: String,
        default: null,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
    // IPS fields legitimately carry empty objects (validation: {}, meta: {});
    // minimize would strip them and break generators consuming the IPS
    minimize: false,
  },
);

// Indexes
projectSchema.index({ ownerId: 1, updatedAt: -1 });
projectSchema.index({ status: 1, 'hosted.expiresAt': 1 });

// Hosted-URL resolution reads publicId, so it must be unique and indexed.
// PARTIAL filters are load-bearing on both: every document written before slugs
// carries `null`, and a plain unique index would reject the second one.
projectSchema.index(
  { publicId: 1 },
  { unique: true, partialFilterExpression: { publicId: { $type: 'string' } } },
);
// Slugs are cosmetic, so they only need to be unambiguous per owner.
projectSchema.index(
  { ownerId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);

export const Project = model<IProject>('Project', projectSchema);

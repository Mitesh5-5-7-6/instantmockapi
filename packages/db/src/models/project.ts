import { Schema, model, Document, Types } from 'mongoose';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

export interface IProject extends Document {
  ownerId: Types.ObjectId;
  name: string;
  /** What this project generates. Absent on documents written before kinds. */
  kind?: 'project' | 'single';
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
  status: 'draft' | 'generating' | 'active' | 'expired';
  inputSource: {
    type: 'json' | 'swagger' | 'builder' | 'docs';
    raw: string;
  };
  ips: InternalProjectSchema;
  currentVersion: number;
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
      enum: ['project', 'single'],
      default: 'project',
    },
    publicId: {
      type: String,
      default: null,
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

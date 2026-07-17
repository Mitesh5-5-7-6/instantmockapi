import { Schema, model, Document, Types } from 'mongoose';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

export interface IProject extends Document {
  ownerId: Types.ObjectId;
  name: string;
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

export const Project = model<IProject>('Project', projectSchema);

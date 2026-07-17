import { Schema, model, Document, Types } from 'mongoose';
import type { InternalProjectSchema, GenerationConfig } from '@instantmockapi/ips';

export interface IVersion extends Document {
  projectId: Types.ObjectId;
  version: number;
  ipsSnapshot: InternalProjectSchema;
  configSnapshot: GenerationConfig;
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
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // snapshot is immutable
    // Keep empty objects in IPS snapshots (validation: {}, meta: {})
    minimize: false,
  },
);

// Indexes
versionSchema.index({ projectId: 1, version: -1 });

export const Version = model<IVersion>('Version', versionSchema);

import { Schema, model, Document, Types } from 'mongoose';

export type ArtifactType =
  | 'ips'
  | 'json_schema'
  | 'zod'
  | 'yup'
  | 'typescript'
  | 'mock_data'
  | 'openapi'
  | 'postman'
  | 'hosted_api'
  | 'export_zip';

export type ArtifactStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface IArtifact extends Document {
  projectId: Types.ObjectId;
  artifactType: ArtifactType;
  version: number;
  status: ArtifactStatus;
  workerId: string | null;
  generatedAt: Date | null;
  errorMessage: string | null;
  storageRef: string | null;
}

const artifactSchema = new Schema<IArtifact>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    artifactType: {
      type: String,
      required: true,
      enum: [
        'ips',
        'json_schema',
        'zod',
        'yup',
        'typescript',
        'mock_data',
        'openapi',
        'postman',
        'hosted_api',
        'export_zip',
      ],
    },
    version: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'generating', 'completed', 'failed'],
      default: 'pending',
    },
    workerId: {
      type: String,
      default: null,
    },
    generatedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    storageRef: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
artifactSchema.index({ projectId: 1, artifactType: 1, version: 1 }, { unique: true });
artifactSchema.index({ projectId: 1, status: 1 });

export const Artifact = model<IArtifact>('Artifact', artifactSchema);

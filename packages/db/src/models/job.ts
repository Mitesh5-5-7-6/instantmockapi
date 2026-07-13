import { Schema, model, Document, Types } from 'mongoose';

export interface IJobWorker {
  worker: string; // e.g. "A", "B", "C", etc.
  artifactType: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string | null;
}

export interface IJob extends Document {
  projectId: Types.ObjectId;
  version: number;
  type: 'full' | 'partial';
  requestedArtifacts: string[];
  idempotencyKey: string;
  status: 'queued' | 'running' | 'completed' | 'failed_partial';
  workers: IJobWorker[];
  createdAt: Date;
  completedAt: Date | null;
}

const jobWorkerSchema = new Schema<IJobWorker>(
  {
    worker: {
      type: String,
      required: true,
    },
    artifactType: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['queued', 'running', 'completed', 'failed'],
      default: 'queued',
    },
    error: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

const jobSchema = new Schema<IJob>(
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
    type: {
      type: String,
      required: true,
      enum: ['full', 'partial'],
      default: 'full',
    },
    requestedArtifacts: {
      type: [String],
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['queued', 'running', 'completed', 'failed_partial'],
      default: 'queued',
    },
    workers: {
      type: [jobWorkerSchema],
      default: [],
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  },
);

// Indexes
jobSchema.index({ projectId: 1, createdAt: -1 });
jobSchema.index({ idempotencyKey: 1 }, { unique: true });

export const Job = model<IJob>('Job', jobSchema);

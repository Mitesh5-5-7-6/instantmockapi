import { Schema, model, Document, Types } from 'mongoose';

export interface IMockStore extends Document {
  projectId: Types.ObjectId;
  entity: string;
  records: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
}

const mockStoreSchema = new Schema<IMockStore>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    entity: {
      type: String,
      required: true,
      trim: true,
    },
    records: {
      type: [Schema.Types.Mixed] as unknown as typeof Schema.Types.Mixed,
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

/**
 * One record set per `(project, entity)` — **unique**, not merely indexed.
 *
 * The seeder upserts on exactly this pair (`apps/workers/src/processor.ts`,
 * `findOneAndUpdate(..., { upsert: true })`), and an upsert is only atomic
 * against a unique index. Without one, two concurrent seeds of the same entity
 * both miss, both insert, and the collection ends up with two record sets for
 * one entity — after which the hosted runtime's `findOne` serves whichever the
 * driver returns first, so the API answers with records nobody generated last.
 *
 * That concurrency is reachable today, not hypothetical: the worker runs
 * `concurrency: 2`, and `RUN_WORKER_IN_PROCESS` makes a scaled-out API a
 * multi-worker deployment (Phase 6 §8, §10).
 */
mockStoreSchema.index({ projectId: 1, entity: 1 }, { unique: true });

export const MockStore = model<IMockStore>('MockStore', mockStoreSchema);

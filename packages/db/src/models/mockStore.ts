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

// Indexes
mockStoreSchema.index({ projectId: 1, entity: 1 });

export const MockStore = model<IMockStore>('MockStore', mockStoreSchema);

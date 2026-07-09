import { Schema, model, Document, Types } from 'mongoose';

export interface IApiLog extends Document {
  projectId: Types.ObjectId;
  method: string;
  path: string;
  status: number;
  at: Date;
}

const apiLogSchema = new Schema<IApiLog>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    method: {
      type: String,
      required: true,
    },
    path: {
      type: String,
      required: true,
    },
    status: {
      type: Number,
      required: true,
    },
    at: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: false, // only 'at' is used for TTL
  }
);

// TTL Index - expire after 30 days
apiLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const ApiLog = model<IApiLog>('ApiLog', apiLogSchema);

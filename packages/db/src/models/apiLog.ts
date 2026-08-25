import { Schema, model, Document, Types } from 'mongoose';

export interface IApiLog extends Document {
  projectId: Types.ObjectId;
  method: string;
  path: string;
  status: number;
  at: Date;
  /**
   * Server-side handling time in whole milliseconds, or null.
   *
   * Null on every row written before this field existed, and **no backfill is
   * possible** — the information was never captured. Consumers must therefore
   * average over the rows that have it and report the sample size, never coerce
   * a missing value to 0: that would drag the mean toward zero for a full
   * retention window and render as an impossibly fast API.
   */
  durationMs?: number | null;
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
    durationMs: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: false, // only 'at' is used for TTL
  },
);

// TTL Index - expire after 30 days.
// Must stay single-field and must stay separate from the compound index below:
// a TTL index cannot be compound, so the two cannot be "consolidated". Doing so
// would silently disable retention.
apiLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Read path for every dashboard metric: `{projectId: {$in: [...]}, at: {$gte, $lt}}`.
// The field order is forced — the equality field has to precede the range field,
// or Mongo can only bound on `at` and rescans every other project's rows inside
// the window. Descending `at` additionally serves "most recent request for this
// project" without a second index.
apiLogSchema.index({ projectId: 1, at: -1 });

export const ApiLog = model<IApiLog>('ApiLog', apiLogSchema);

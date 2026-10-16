import { Schema, model, Document, Types } from 'mongoose';

/**
 * The AI-written guide on a project's Docs tab, stored once per definition.
 *
 * Keyed by `contextHash`, a hash of the project's AI Context document, which is
 * a deterministic rendering of the definition. An unchanged definition finds
 * its stored guide, so visiting the tab never calls the model; any schema
 * change produces a different hash and therefore a new guide. Older guides are
 * kept, so viewing an earlier version shows the guide written for it.
 *
 * ## Status machine
 *
 *     generating ──▶ ready
 *         │
 *         └────────▶ failed ──regenerate──▶ generating
 *
 * `ready` can also be regenerated on request. Every transition is a
 * conditional update on `status` and `runs`, so a late result from an earlier
 * run cannot overwrite a newer one.
 */
export type ProjectGuideStatus = 'generating' | 'ready' | 'failed';

export interface IProjectGuide extends Document {
  projectId: Types.ObjectId;
  contextHash: string;
  /** The AI Context the guide is written from, so the worker needs no generator. */
  context: string;
  /** Every endpoint the guide may mention; anything else fails its check. */
  endpoints: { method: string; path: string }[];
  /** The definition version it was first requested for; display only. */
  version: number;
  status: ProjectGuideStatus;
  markdown: string | null;
  error: { code: string; message: string } | null;
  /** Part of the queue job id, so a regeneration is a new job, not a no-op. */
  runs: number;
  /** When the current run was queued; a run older than the stuck limit is settled as failed on read. */
  requestedAt: Date;
  /** The Gemini model id. Not `model`: Document already has a `model()` method. */
  aiModel: string | null;
  promptVersion: string | null;
  geminiCalls: number;
  createdAt: Date;
  updatedAt: Date;
}

const projectGuideSchema = new Schema<IProjectGuide>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    contextHash: { type: String, required: true },
    context: { type: String, required: true },
    endpoints: { type: [{ _id: false, method: String, path: String }], default: [] },
    version: { type: Number, required: true },
    status: { type: String, required: true, default: 'generating' },
    markdown: { type: String, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    runs: { type: Number, default: 1 },
    requestedAt: { type: Date, default: () => new Date() },
    aiModel: { type: String, default: null },
    promptVersion: { type: String, default: null },
    geminiCalls: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One guide per definition: concurrent first visits race to insert, and the
// loser reads the winner's row instead of paying for a second model call.
projectGuideSchema.index({ projectId: 1, contextHash: 1 }, { unique: true });

export const ProjectGuide = model<IProjectGuide>('ProjectGuide', projectGuideSchema);

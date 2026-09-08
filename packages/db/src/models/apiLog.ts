import { Schema, model, Document, Types } from 'mongoose';

/**
 * Which URL shape a request addressed.
 *
 * Mirrors `HostedTarget.kind` in the mock runtime, which is where the value comes
 * from — the runtime has already parsed the grammar by the time a row is written,
 * so this is recorded rather than re-derived.
 */
/**
 * `auth` covers the five Auth API endpoints (Phase 3 §4).
 *
 * Its own shape rather than folded into `collection`: an auth request carries no
 * entity, so grouping it with entity traffic would put every signIn attempt in a
 * bucket whose `entity` is null and make the endpoint breakdown lie about its
 * own coverage.
 */
export type ApiLogShape = 'index' | 'collection' | 'record' | 'auth';

/** Longest `userAgent` stored. Unbounded, it is a free field for a caller to bloat every row with. */
export const USER_AGENT_MAX_LENGTH = 256;

export interface IApiLog extends Document {
  projectId: Types.ObjectId;
  method: string;
  /**
   * The URL exactly as requested, query string and concrete record id included.
   *
   * **Deliberately not normalised**, and deliberately not the field aggregations
   * group on. `/products/68f1a2b3` and `/products?page=2` are distinct values
   * here, which makes this useless for counting endpoints and exactly right for a
   * request log — the one place a reader wants to see what was literally called.
   * `entity` + `shape` below are the grouping keys.
   */
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
  /**
   * Canonical entity path the request resolved to, or null.
   *
   * Null for the discovery document (which belongs to no entity) and for a
   * request that found the project but not the entity — a 404 that still counts
   * toward totals and error rates, but is not an endpoint and so is excluded from
   * per-endpoint reporting.
   *
   * **The entity name, not a templated path.** Item paths are entity-specific:
   * `entityEndpoints` builds `/products/{sku}` from the entity's identity field,
   * so a stored template would stop matching the moment that field or the entity
   * were renamed. Storing the name lets a reader rebuild the *current* path from
   * the current schema and still see historical traffic against it.
   */
  entity?: string | null;
  /** Which URL shape was hit. Null under the same conditions as `entity`. */
  shape?: ApiLogShape | null;
  /**
   * Client address, or null.
   *
   * Meaningful only because the runtime sets `trustProxy` — without it this would
   * record the load balancer on every row. A hosted mock URL is public and
   * unauthenticated, so "who is calling this" is a question its owner can
   * reasonably ask.
   */
  ip?: string | null;
  /** Caller's user-agent, truncated to `USER_AGENT_MAX_LENGTH`, or null. */
  userAgent?: string | null;
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
    entity: {
      type: String,
      default: null,
    },
    shape: {
      type: String,
      // No `enum` validator. A row is written from a fire-and-forget hook whose
      // rejection is swallowed, so a validation failure would silently drop the
      // log rather than surface anywhere — the type is enforced at the one call
      // site instead, where a mistake is a compile error.
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: USER_AGENT_MAX_LENGTH,
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

// No index on `entity`, `shape`, `method` or `status`. Every read — the metrics
// aggregation and the log list alike — is already bounded to one project and one
// time window by the index above, and filters within that bounded set for a
// single project's retention window. Indexing them would cost write throughput on
// the hottest collection in the platform to save nothing measurable.

export const ApiLog = model<IApiLog>('ApiLog', apiLogSchema);

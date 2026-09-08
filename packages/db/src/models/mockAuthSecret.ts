import { randomBytes } from 'node:crypto';
import { Schema, model, Document, Types } from 'mongoose';

/**
 * The signing key for one project's generated Auth API (Phase 3 §7, §23, §27).
 *
 * ## Why a per-project key
 *
 * §14 requires that a token from Project A cannot authenticate against
 * Project B. A single runtime key with a project claim would satisfy that only
 * as long as every code path remembered to check the claim — and one leaked key
 * would compromise every hosted project at once. A key per project makes the
 * isolation **structural**: a token signed for another project fails
 * verification, before any claim is read, with no check to forget.
 *
 * ## Why its own collection rather than a field on `Project`
 *
 * The same reasoning, applied to leakage. §23 forbids exposing JWT secrets and
 * §27 forbids putting them in a Blueprint; `Project` is serialized by
 * `toProjectSummary`, `toProjectDetail`, the blueprint exporter and the
 * activity feed. A field there is one forgotten `select` or one spread operator
 * away from a response body. A field that is not on the document cannot be
 * serialized by accident — the strongest available form of "never expose this".
 *
 * §27's "imported Blueprints must generate new runtime secrets" then costs
 * nothing: an import creates a project with no row here, and the next request
 * that needs a key mints a fresh one.
 */
export interface IMockAuthSecret extends Document {
  projectId: Types.ObjectId;
  /** 256 bits of CSPRNG output, hex. Never leaves the server. */
  secret: string;
  createdAt: Date;
}

const mockAuthSecretSchema = new Schema<IMockAuthSecret>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    secret: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/** One key per project, enforced rather than assumed — see `ensureAuthSecret`. */
mockAuthSecretSchema.index({ projectId: 1 }, { unique: true });

export const MockAuthSecret = model<IMockAuthSecret>('MockAuthSecret', mockAuthSecretSchema);

/** 256 bits, which is HS256's full key size — a shorter key weakens the MAC. */
export const AUTH_SECRET_BYTES = 32;

/**
 * The project's signing key, minting one if it has none.
 *
 * Lazy rather than at publish, following the `ensurePublicIdentity` precedent:
 * every project that ever needs a key gets one on the request that needs it, and
 * projects with authentication disabled never accumulate a secret they cannot
 * use.
 *
 * ## The race matters here more than usual
 *
 * Two concurrent signUps on a fresh project would both find no row. A
 * last-write-wins mint would hand out tokens signed with a key that is then
 * overwritten — and every one of those tokens would fail verification a moment
 * later, for no reason the user could see. So the insert is guarded by the
 * unique index and a duplicate loses gracefully: on `E11000` we re-read and use
 * the winner's key. The upsert cannot be used for this, because
 * `$setOnInsert` with a fresh random value still evaluates that value on every
 * caller — the index is what makes exactly one of them authoritative.
 */
export async function ensureAuthSecret(projectId: string): Promise<string> {
  const existing = await MockAuthSecret.findOne({ projectId });
  if (existing) {
    return existing.secret;
  }

  const secret = randomBytes(AUTH_SECRET_BYTES).toString('hex');
  try {
    const created = await MockAuthSecret.create({ projectId, secret });
    return created.secret;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }
    // Another request minted first. Its key is the real one; ours is discarded
    // unused, which is why generating it eagerly costs nothing.
    const winner = await MockAuthSecret.findOne({ projectId });
    if (!winner) {
      throw error;
    }
    return winner.secret;
  }
}

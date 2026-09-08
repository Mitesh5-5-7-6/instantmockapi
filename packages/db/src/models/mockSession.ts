import { Schema, model, Document, Types } from 'mongoose';

/**
 * One refresh session on a generated mock API (Phase 3 §8, §11).
 *
 * ## Only a hash is stored
 *
 * §23 forbids exposing tokens, and the strongest form of that is not holding
 * them: the refresh token exists in the client and nowhere else. A database
 * leak hands over expired-at-a-glance hashes rather than the ability to mint an
 * access token for every account — the same reasoning `AuthToken` already
 * applies to emailed links.
 *
 * ## Why a session row exists at all
 *
 * Access tokens are stateless and expire on their own (§7). Refresh tokens
 * cannot be, because §8 requires **revocation** and §11 requires logout to
 * invalidate one — neither of which a self-contained signed token can do. The
 * row is the revocation list.
 *
 * ## Rotation
 *
 * §8 prefers rotation, so `POST /refresh` revokes the presented session and
 * issues a new one. `replacedBy` records the successor, which is what makes a
 * replayed token detectable rather than merely rejected: presenting a revoked
 * session that has a successor is the signature of a stolen token, not of a
 * client that is simply out of date.
 */
export interface IMockSession extends Document {
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  /** SHA-256 of the refresh token, hex. Never the token itself. */
  tokenHash: string;
  expiresAt: Date;
  /** Stamped on logout, rotation, or a detected replay. Non-null means spent. */
  revokedAt: Date | null;
  /** The session that replaced this one, when rotation replaced it. */
  replacedBy: Types.ObjectId | null;
  createdAt: Date;
}

const mockSessionSchema = new Schema<IMockSession>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'MockUser',
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedBy: {
      type: Schema.Types.ObjectId,
      ref: 'MockSession',
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/** Redemption looks a session up by its hash, and only by its hash. */
mockSessionSchema.index({ tokenHash: 1 }, { unique: true });

/** Logout-everywhere and per-user cleanup. */
mockSessionSchema.index({ projectId: 1, userId: 1 });

/**
 * Self-expiring, so revoked and lapsed sessions do not accumulate forever on a
 * collection nothing prunes.
 *
 * `expireAfterSeconds: 0` means "expire at the value of this field", so the row
 * survives exactly as long as the token it tracks could be presented. A revoked
 * row must stay until then — deleting it on revocation would make a replayed
 * token indistinguishable from an unknown one.
 */
mockSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MockSession = model<IMockSession>('MockSession', mockSessionSchema);

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Single-use, expiring tokens emailed to a user (doc 13 §1).
 *
 * Three deliberate properties:
 *
 * 1. **Only a hash is stored.** The token itself exists only in the email. A
 *    database leak must not hand over the ability to reset every account, which
 *    storing the raw value would.
 * 2. **Single use**, enforced atomically — redemption is a `findOneAndUpdate`
 *    filtered on `usedAt: null`, so a double-clicked link cannot redeem twice.
 * 3. **Self-expiring** via a TTL index, so nothing accumulates and an abandoned
 *    reset link stops working on its own.
 */
export type AuthTokenKind = 'verify' | 'reset' | 'set-password';

export interface IAuthToken extends Document {
  userId: Types.ObjectId;
  kind: AuthTokenKind;
  /** SHA-256 of the emailed token, hex. Never the token itself. */
  tokenHash: string;
  expiresAt: Date;
  /** Stamped on redemption; a non-null value means spent. */
  usedAt: Date | null;
  createdAt: Date;
}

/** How long each kind stays valid. */
export const AUTH_TOKEN_TTL_SECONDS: Record<AuthTokenKind, number> = {
  // Long enough to survive a mail delay and a distracted user.
  verify: 24 * 60 * 60,
  // Short: a reset link in an inbox is a standing key to the account.
  reset: 60 * 60,
  'set-password': 60 * 60,
};

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    kind: {
      type: String,
      required: true,
      enum: ['verify', 'reset', 'set-password'],
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Mongo's TTL monitor removes documents once `expiresAt` passes. Note it runs
// about once a minute, so expiry is enforced in the query too — never rely on
// the sweeper for correctness, only for cleanup.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Invalidating a user's other outstanding tokens of the same kind when a new one
// is issued, so requesting a second reset link retires the first.
authTokenSchema.index({ userId: 1, kind: 1 });

export const AuthToken = model<IAuthToken>('AuthToken', authTokenSchema);

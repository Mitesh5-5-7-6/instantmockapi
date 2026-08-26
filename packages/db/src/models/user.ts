import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  /** Display name. Absent on every account created before this field existed. */
  name?: string | null;
  authProvider: 'google' | 'email';
  /**
   * scrypt hash in PHC format (see packages/auth password.ts).
   *
   * **Null is meaningful, not merely absent**: it marks an account that has no
   * password yet — either created by the old passwordless login, or created via
   * Google. Signing in to such an account emails a set-password link rather than
   * rejecting the attempt.
   */
  passwordHash?: string | null;
  /** Null until the emailed verification link is used. Unverified cannot sign in. */
  emailVerifiedAt?: Date | null;
  /**
   * Revocation counter. Bumped on password change, password reset and sign-out;
   * a refresh token carrying an older value is refused, which ends every session
   * at once without a session store.
   */
  tokenVersion: number;
  /**
   * Google's stable subject id.
   *
   * Matched before email, because an address can change at Google while `sub`
   * cannot — keying on email alone would silently split or merge accounts.
   */
  googleSub?: string | null;
  plan: 'free' | 'pro' | 'enterprise';
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    },
    authProvider: {
      type: String,
      required: true,
      enum: ['google', 'email'],
    },
    passwordHash: {
      type: String,
      default: null,
      // Never returned by a query unless asked for explicitly, so it cannot leak
      // through a serializer someone adds later without thinking about it.
      select: false,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    tokenVersion: {
      type: Number,
      required: true,
      default: 0,
    },
    googleSub: {
      type: String,
      default: null,
    },
    plan: {
      type: String,
      required: true,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free',
    },
  },
  {
    timestamps: true,
  },
);

// The unique email index comes from `unique: true` on the path definition —
// declaring it again via schema.index() would create a duplicate definition
// that makes index syncing nondeterministic.

// Partial rather than sparse-unique: every pre-existing user has googleSub null,
// and a plain unique index would reject all but the first of them.
userSchema.index(
  { googleSub: 1 },
  { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } },
);

export const User = model<IUser>('User', userSchema);

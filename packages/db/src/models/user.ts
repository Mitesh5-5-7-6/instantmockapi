import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  /** Display name. Absent on every account created before this field existed. */
  name?: string | null;
  authProvider: 'google' | 'email';
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

export const User = model<IUser>('User', userSchema);

import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
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

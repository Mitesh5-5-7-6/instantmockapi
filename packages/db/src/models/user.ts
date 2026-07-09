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
  }
);

// Indexes
userSchema.index({ email: 1 }, { unique: true });

export const User = model<IUser>('User', userSchema);

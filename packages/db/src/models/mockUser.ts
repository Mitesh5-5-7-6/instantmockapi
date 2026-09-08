import { Schema, model, Document, Types } from 'mongoose';

/**
 * An end user of somebody's **generated** mock API (Phase 3 §22).
 *
 * ## Not a `User`
 *
 * `User` is a person who signs in to InstantMockAPI and owns projects.
 * A `MockUser` is a customer of a project's hosted API — created by a `POST`
 * to that API's own `/signUp`, scoped to one project, and with no access to the
 * platform whatsoever. The two populations never mix, and the token that
 * authenticates one must never authenticate the other.
 *
 * ## Why not `MockStore`
 *
 * `MockStore` is keyed `(projectId, entity)` with no version, and the
 * `mock_data` generator **overwrites** `records` wholesale — which Phase 2 now
 * *forces* on any schema-affecting rollback. Seeded fixtures are meant to be
 * replaceable; accounts people created are not. Storing users there would mean
 * a rollback silently deleting every signup, with no warning at the moment it
 * happened.
 *
 * So this is its own collection. §23 forbids a second *database*, not a second
 * collection, and nothing in the generation pipeline touches this one.
 */
export interface IMockUser extends Document {
  projectId: Types.ObjectId;
  /** Lowercased at write time, so the unique index is case-insensitive. */
  email: string;
  /** scrypt, via `hashPassword`. §23: never the plaintext, never returned. */
  passwordHash: string;
  /**
   * The project's custom signup fields (§5), as authored.
   *
   * `Mixed` because the shape is the project's own `authentication.userFields`
   * and changes with its definition. Validated against that list on signUp, so
   * what lands here is only ever what the project declared — the reserved names
   * are rejected by `validateIPS` before a project can ask for them.
   */
  fields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const mockUserSchema = new Schema<IMockUser>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    fields: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Unique **per project**, which is the whole isolation story at the data layer:
 * the same address can sign up to two different mock APIs, and neither account
 * can be reached from the other's endpoints.
 */
mockUserSchema.index({ projectId: 1, email: 1 }, { unique: true });

export const MockUser = model<IMockUser>('MockUser', mockUserSchema);

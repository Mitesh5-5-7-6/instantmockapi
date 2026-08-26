/**
 * The single-use tokens that go into emails (doc 13 §1).
 *
 * Two operations, and the discipline in each is the whole point:
 *
 * **Issue** returns the token to the caller *and stores only its hash*. Nothing
 * anywhere — not the database, not a log — holds a value that could be replayed.
 * A dump of the collection is useless.
 *
 * **Redeem** is a single atomic update, not a read followed by a write. A mail
 * client that prefetches links, or a user who double-clicks, sends two requests
 * at once; a read-then-write would let both through, and for a password reset
 * that means two different passwords racing.
 */

import { createHash, randomBytes } from 'node:crypto';
// Type-only: `mongoose` is not a dependency of this app, so a value import would
// typecheck and then throw "Cannot find package" at runtime.
import type { Types } from 'mongoose';
import { AuthToken, AUTH_TOKEN_TTL_SECONDS, type AuthTokenKind } from '@instantmockapi/db';

/**
 * 32 bytes of randomness, base64url — 256 bits, so guessing is not a threat
 * model and the value survives being pasted out of a wrapped email body.
 */
const TOKEN_BYTES = 32;

/**
 * SHA-256, not scrypt.
 *
 * Deliberately different from password hashing, and for a reason: a password is
 * low-entropy and needs a slow KDF to survive an offline dictionary attack. This
 * token is 256 uniformly random bits, so there is no dictionary to run — and a
 * slow hash would instead make every verification email a 64MB allocation.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedToken {
  /** The value that goes in the email. Never stored. */
  token: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

/**
 * Mint a token of one kind for one user, retiring any outstanding ones.
 *
 * Retiring the previous tokens matters: someone who clicks "resend" three times
 * has three live links, and the two older emails should stop working the moment
 * the newest is sent — otherwise a link from an email forwarded weeks ago is
 * still a way in.
 */
export async function issueAuthToken(
  userId: Types.ObjectId,
  kind: AuthTokenKind,
  now: Date = new Date(),
): Promise<IssuedToken> {
  const expiresInSeconds = AUTH_TOKEN_TTL_SECONDS[kind];
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);

  await AuthToken.deleteMany({ userId, kind });

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await AuthToken.create({
    userId,
    kind,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, expiresAt, expiresInSeconds };
}

/**
 * Spend a token, or return null.
 *
 * Null covers every failure identically — unknown, wrong kind, already used,
 * expired — because the caller must not turn them into different responses. "Not
 * yet used but expired" versus "already used" would tell an attacker holding a
 * stolen link whether the owner has since noticed.
 *
 * The `usedAt: null` and `expiresAt` conditions are inside the update, so the
 * check and the write cannot be separated by a concurrent request.
 */
export async function redeemAuthToken(
  token: string,
  kind: AuthTokenKind,
  now: Date = new Date(),
): Promise<Types.ObjectId | null> {
  const redeemed = await AuthToken.findOneAndUpdate(
    {
      tokenHash: hashToken(token),
      kind,
      usedAt: null,
      // Expiry is enforced here rather than left to the TTL index: Mongo's
      // sweeper runs roughly once a minute, so an expired document is still
      // readable for a while after it should have stopped working.
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );
  return redeemed ? redeemed.userId : null;
}

/**
 * Drop every outstanding token for a user.
 *
 * Called after a password is set or changed: a reset link that was in flight at
 * that moment must not still work, or an attacker who requested one before being
 * locked out keeps a way back in.
 */
export async function revokeAuthTokens(userId: Types.ObjectId): Promise<void> {
  await AuthToken.deleteMany({ userId });
}

/** Exposed for tests, which need to look up a token they have the plaintext of. */
export const hashAuthTokenForTest = hashToken;

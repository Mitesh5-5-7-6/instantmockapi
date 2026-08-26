/**
 * Google account linking (doc 13 §6).
 *
 * The token verification itself lives in
 * [packages/auth/src/google.ts](../../../packages/auth/src/google.ts), because
 * that is where `jose` is a declared dependency — importing it here would
 * typecheck through pnpm's hoisting and then fail at runtime with "Cannot find
 * package". What stays here is the half that needs the database.
 */

import { User, type IUser } from '@instantmockapi/db';
import type { GoogleIdentity } from '@instantmockapi/auth';

/**
 * Find or create the account for a Google identity.
 *
 * **`googleSub` is matched before email**, and the order is load-bearing: an
 * address can change at Google while `sub` cannot. Keying on email alone would
 * mean a user who changed their Google address silently gets a second account,
 * and — worse — that their old address becoming available to someone else would
 * hand that person the original account.
 */
export async function findOrCreateGoogleUser(identity: GoogleIdentity): Promise<IUser> {
  const bySub = await User.findOne({ googleSub: identity.sub });
  if (bySub) {
    // Keep the address current: Google is authoritative for it, and it is what
    // our own emails are sent to.
    if (bySub.email !== identity.email) {
      bySub.email = identity.email;
      await bySub.save();
    }
    return bySub;
  }

  const byEmail = await User.findOne({ email: identity.email });
  if (byEmail) {
    // Linking, not creating a duplicate. Safe because Google told us the address
    // is verified — which is exactly the same proof our own email link provides.
    byEmail.googleSub = identity.sub;
    byEmail.emailVerifiedAt = byEmail.emailVerifiedAt ?? new Date();
    byEmail.name = byEmail.name ?? identity.name;
    await byEmail.save();
    return byEmail;
  }

  return User.create({
    email: identity.email,
    name: identity.name,
    authProvider: 'google',
    googleSub: identity.sub,
    // Verified on creation: Google has already done it. Requiring our own
    // confirmation email on top would be asking for the same proof twice.
    emailVerifiedAt: new Date(),
    // Deliberately no passwordHash. Signing in with an email address later emails
    // a set-password link (doc 13 D3) rather than failing.
    passwordHash: null,
  });
}

/**
 * Auth business logic (doc 13 §1), kept out of the route handlers the way
 * generation-service.ts is.
 *
 * Two rules run through everything here.
 *
 * **1. Never reveal whether an address has an account.** `signUp`,
 * `requestPasswordReset` and `resendVerification` all return the same value
 * whatever they found, and the branch that "does nothing" still costs the same
 * work. A signup form that answers differently for a known address is an
 * account-existence oracle, and the accounts it enumerates are then worth
 * attacking.
 *
 * **2. An account with no password is a state to handle, not an error.** Accounts
 * created by the old passwordless login, and accounts created through Google,
 * have `passwordHash: null`. Rejecting their sign-in would strand them; instead
 * the attempt emails a set-password link.
 */

import type { Types } from 'mongoose';
import { AppError, logger } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { User, type IUser } from '@instantmockapi/db';
import { hashPassword, verifyPassword, needsRehash } from '@instantmockapi/auth';
import { issueAuthToken, redeemAuthToken, revokeAuthTokens } from './auth-tokens.js';
import { sendQuietly, type Mailer } from './email.js';
import {
  authLink,
  verifyEmailMessage,
  resetPasswordMessage,
  setPasswordMessage,
  accountExistsMessage,
} from './email-templates.js';

export interface AuthServiceDeps {
  config: EnvConfig;
  mailer: Mailer;
}

/** Web routes the emails link to. Kept together so a rename is one edit. */
const VERIFY_PATH = 'verify-email';
const RESET_PATH = 'reset-password';
const LOGIN_PATH = 'login';
const FORGOT_PATH = 'forgot-password';

/**
 * Minimum password length, enforced here and not only in the browser.
 *
 * 10 rather than the traditional 8, and no composition rules: NIST 800-63B is
 * explicit that length beats mandated symbol classes, which mostly produce
 * `Password1!`.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * A tiny deny-list of the passwords that actually get used.
 *
 * Not a serious dictionary — it is a guard rail against the handful of choices
 * that would fall to a first guess. The real defence is the rate limit.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwertyuiop',
  '1234567890',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'welcome123',
  'instantmockapi',
]);

/**
 * Why a password is unacceptable, or an empty list.
 *
 * Returns every reason at once so the form can show them together rather than
 * one per submission.
 */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('This password is too common — pick something less guessable');
  }
  if (email !== undefined && email !== '') {
    const local = email.split('@')[0] ?? '';
    // The email is public knowledge and is submitted alongside the password, so
    // a password derived from it is a password the attacker already has.
    if (
      password.toLowerCase() === email.toLowerCase() ||
      password.toLowerCase() === local.toLowerCase()
    ) {
      problems.push('Do not use your email address as your password');
    }
  }
  return problems;
}

/** Reject a password the browser should already have refused. */
function assertUsablePassword(password: string, email: string): void {
  const problems = passwordProblems(password, email);
  if (problems.length > 0) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: problems[0] ?? 'That password cannot be used',
      // One detail per problem, so the form can show them all at once against
      // the right field rather than one per submission.
      details: problems.map((issue) => ({ path: 'password', issue })),
    });
  }
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normaliseName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Send the verification email for a user, ignoring delivery failures. */
async function sendVerification(user: IUser, deps: AuthServiceDeps): Promise<void> {
  const issued = await issueAuthToken(user._id as Types.ObjectId, 'verify');
  await sendQuietly(
    deps.mailer,
    verifyEmailMessage({
      to: user.email,
      name: user.name,
      url: authLink(deps.config.appUrl, VERIFY_PATH, issued.token),
      expiresInSeconds: issued.expiresInSeconds,
    }),
  );
}

/**
 * Create an account, or quietly do nothing if the address already has one.
 *
 * The two branches are indistinguishable to the caller — same return value, and
 * an email either way. The existing owner is told someone tried, because they
 * have a right to know; the person who submitted the form is told nothing.
 */
export async function signUp(
  input: { email: string; password: string; name?: string | null },
  deps: AuthServiceDeps,
): Promise<void> {
  const email = normaliseEmail(input.email);
  assertUsablePassword(input.password, email);

  const existing = await User.findOne({ email });
  if (existing) {
    await sendQuietly(
      deps.mailer,
      accountExistsMessage({
        to: existing.email,
        name: existing.name,
        signInUrl: authLinkBase(deps.config.appUrl, LOGIN_PATH),
        resetUrl: authLinkBase(deps.config.appUrl, FORGOT_PATH),
      }),
    );
    // Hashing anyway, even though nothing is written. Skipping it would make the
    // "already exists" path measurably faster — a timing oracle that hands back
    // exactly the answer the identical response withholds.
    await hashPassword(input.password);
    return;
  }

  const user = await User.create({
    email,
    name: normaliseName(input.name),
    authProvider: 'email',
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: null,
  });
  await sendVerification(user, deps);
}

/** A link into the web app with no token attached. */
function authLinkBase(appUrl: string, path: string): string {
  return new URL(path, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
}

/**
 * What a sign-in attempt produced.
 *
 * `emailed` is not a failure and not a success: the credentials could not be
 * checked because there is nothing to check them against, so a link was sent
 * instead. The UI shows the same neutral message it shows for a reset.
 */
export type LoginOutcome = { kind: 'signed-in'; user: IUser } | { kind: 'emailed-set-password' };

/**
 * Verify a password and report what should happen.
 *
 * Throws UNAUTHORIZED for a wrong password or an unknown address — identically,
 * so login is not an oracle either — and EMAIL_NOT_VERIFIED when the credentials
 * were right but the address is unconfirmed.
 */
export async function logIn(
  input: { email: string; password: string },
  deps: AuthServiceDeps,
): Promise<LoginOutcome> {
  const email = normaliseEmail(input.email);
  // `+passwordHash` because the field is `select: false` — without this the hash
  // is undefined and every sign-in looks like a passwordless account.
  const user = await User.findOne({ email }).select('+passwordHash');

  if (!user) {
    // A real scrypt run against a throwaway hash, so "no such account" takes as
    // long as "wrong password". Without it the response time is the oracle.
    await verifyPassword(input.password, DUMMY_HASH);
    throw invalidCredentials();
  }

  if (!user.passwordHash) {
    // The migration path: no password to check, so offer to set one (doc 13 §1).
    const issued = await issueAuthToken(user._id as Types.ObjectId, 'set-password');
    await sendQuietly(
      deps.mailer,
      setPasswordMessage({
        to: user.email,
        name: user.name,
        url: authLink(deps.config.appUrl, RESET_PATH, issued.token),
        expiresInSeconds: issued.expiresInSeconds,
      }),
    );
    return { kind: 'emailed-set-password' };
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw invalidCredentials();
  }

  if (!user.emailVerifiedAt) {
    throw new AppError({
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Confirm your email address to sign in. Check your inbox for the link.',
    });
  }

  // Sign-in is the only moment the plaintext exists, so it is the only moment a
  // weaker stored hash can be upgraded. Failure here must not fail the sign-in.
  if (needsRehash(user.passwordHash)) {
    try {
      user.passwordHash = await hashPassword(input.password);
      await user.save();
    } catch (error) {
      logger.warn('Password rehash failed; sign-in continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { kind: 'signed-in', user };
}

/**
 * A real scrypt hash of a random value nobody knows, used to spend the same time
 * on the unknown-address path as on a genuine check.
 *
 * It must be a *parseable* hash: `verifyPassword` returns false immediately on a
 * malformed one without running the KDF, which would leave exactly the timing
 * difference this exists to remove. Generated once, at the current cost
 * parameters, and never verifiable — nobody has the input.
 */
const DUMMY_HASH =
  'scrypt$65536$8$1$Y0Q57dj95kkiOVpPr0WP9Q$oKTlwW45nEivQphUi_Y6yYPnA09fXuvBcmtv00EOlGS-' +
  'OTbRRLi0IlYNWmSeKGxdD4xcW-Oh-HaP0jZl8p0ICQ';

function invalidCredentials(): AppError {
  // One message for both "no such account" and "wrong password". Distinguishing
  // them would turn the login form into the enumeration oracle that signup is
  // carefully not.
  return new AppError({ code: 'UNAUTHORIZED', message: 'Incorrect email or password' });
}

/**
 * Send a reset link if the address exists.
 *
 * Always resolves, and the caller always answers the same way. An account with
 * no password gets a set-password link rather than a reset one, since "reset"
 * would be a lie.
 */
export async function requestPasswordReset(email: string, deps: AuthServiceDeps): Promise<void> {
  const user = await User.findOne({ email: normaliseEmail(email) }).select('+passwordHash');
  if (!user) {
    return;
  }

  const kind = user.passwordHash ? 'reset' : 'set-password';
  const issued = await issueAuthToken(user._id as Types.ObjectId, kind);
  const url = authLink(deps.config.appUrl, RESET_PATH, issued.token);
  const message =
    kind === 'reset'
      ? resetPasswordMessage({
          to: user.email,
          name: user.name,
          url,
          expiresInSeconds: issued.expiresInSeconds,
        })
      : setPasswordMessage({
          to: user.email,
          name: user.name,
          url,
          expiresInSeconds: issued.expiresInSeconds,
        });
  await sendQuietly(deps.mailer, message);
}

/**
 * Resend a verification email if the address exists and is unverified.
 *
 * Silent for an unknown address *and* for an already-verified one: answering
 * differently would say which addresses are registered and which are confirmed.
 */
export async function resendVerification(email: string, deps: AuthServiceDeps): Promise<void> {
  const user = await User.findOne({ email: normaliseEmail(email) });
  if (!user || user.emailVerifiedAt) {
    return;
  }
  await sendVerification(user, deps);
}

/** Redeem a verification token. Returns the now-verified user. */
export async function verifyEmail(token: string): Promise<IUser> {
  const userId = await redeemAuthToken(token, 'verify');
  if (!userId) {
    throw invalidToken();
  }
  const user = await User.findById(userId);
  if (!user) {
    throw invalidToken();
  }
  // Idempotent in effect: a second click finds the token spent and 400s, but a
  // user who was already verified is not "unverified" by this path.
  user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
  await user.save();
  return user;
}

/**
 * Redeem a reset or set-password token and write the new password.
 *
 * Bumping `tokenVersion` is the part that matters: it invalidates every
 * outstanding refresh token, so a reset actually ends the attacker's session
 * rather than merely changing the lock while they are still inside.
 */
export async function resetPassword(input: { token: string; password: string }): Promise<IUser> {
  // Either kind redeems here. The distinction is only about what the email said;
  // by the time the link is clicked the action is identical.
  const userId =
    (await redeemAuthToken(input.token, 'reset')) ??
    (await redeemAuthToken(input.token, 'set-password'));
  if (!userId) {
    throw invalidToken();
  }

  const user = await User.findById(userId);
  if (!user) {
    throw invalidToken();
  }
  assertUsablePassword(input.password, user.email);

  user.passwordHash = await hashPassword(input.password);
  user.tokenVersion += 1;
  // Proving control of the mailbox is what verification asks for, and clicking a
  // link sent to it is exactly that — so a reset also confirms the address.
  user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
  await user.save();

  // Any other link still in flight — a second reset request, an old verification
  // email — stops working now.
  await revokeAuthTokens(user._id as Types.ObjectId);
  return user;
}

/**
 * Change the password of a signed-in user.
 *
 * Requires the current one even though the session is already authenticated: it
 * is what stops someone at a borrowed laptop from taking the account, and the
 * `tokenVersion` bump then locks out every other session.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<IUser> {
  const user = await User.findById(input.userId).select('+passwordHash');
  if (!user) {
    throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }

  if (!user.passwordHash) {
    // No current password to check, so this route cannot authorise the change.
    // The set-password email flow is the way in, and it proves mailbox control.
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: 'This account has no password yet. Use "Forgot password" to set one.',
    });
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError({ code: 'UNAUTHORIZED', message: 'Your current password is incorrect' });
  }

  assertUsablePassword(input.newPassword, user.email);

  user.passwordHash = await hashPassword(input.newPassword);
  user.tokenVersion += 1;
  await user.save();
  await revokeAuthTokens(user._id as Types.ObjectId);
  return user;
}

/**
 * End every session for a user.
 *
 * Bumping the counter is what makes sign-out real: the refresh cookie is cleared
 * in the same response, but a copy of that cookie taken earlier would otherwise
 * still work.
 */
export async function signOutEverywhere(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

function invalidToken(): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message: 'That link is invalid or has expired. Request a new one.',
  });
}

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('@instantmockapi/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@instantmockapi/queue')>();
  return {
    ...actual,
    getRedisConnection: vi.fn(),
    getJobQueue: vi.fn(),
    closeQueue: vi.fn(async () => {}),
  };
});

import { User } from '@instantmockapi/db';
import { clearDb, startTestDb, stopTestDb } from './testing/harness.js';
import { findOrCreateGoogleUser } from './google-auth.js';

beforeAll(async () => {
  await startTestDb();
}, 600_000);

afterAll(stopTestDb);
beforeEach(clearDb);

const identity = { sub: 'google-sub-1', email: 'ada@example.com', name: 'Ada Lovelace' };

describe('findOrCreateGoogleUser', () => {
  it('creates a verified, passwordless account for a new identity', async () => {
    const user = await findOrCreateGoogleUser(identity);

    expect(user.email).toBe('ada@example.com');
    expect(user.authProvider).toBe('google');
    expect(user.googleSub).toBe('google-sub-1');
    // Verified on creation: Google has already proved the address, and asking
    // for our own confirmation email would be the same proof twice.
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);

    const stored = await User.findById(user._id).select('+passwordHash');
    // No password — signing in with the email address later emails a
    // set-password link rather than failing.
    expect(stored?.passwordHash).toBeNull();
  });

  it('returns the same account on a second sign-in', async () => {
    const first = await findOrCreateGoogleUser(identity);
    const second = await findOrCreateGoogleUser(identity);
    expect(String(second._id)).toBe(String(first._id));
    expect(await User.countDocuments({})).toBe(1);
  });

  /**
   * The order that matters: `googleSub` is matched *before* email.
   *
   * An address can change at Google; `sub` cannot. Matching on email first would
   * mean a user who changed their Google address silently gets a second account —
   * and, worse, that their old address becoming available to somebody else would
   * hand that person the original account.
   */
  it('follows the account when the Google address changes', async () => {
    const original = await findOrCreateGoogleUser(identity);
    const renamed = await findOrCreateGoogleUser({ ...identity, email: 'ada@newdomain.com' });

    expect(String(renamed._id)).toBe(String(original._id));
    // And the stored address is updated, because that is where our own emails go.
    expect(renamed.email).toBe('ada@newdomain.com');
    expect(await User.countDocuments({})).toBe(1);
  });

  it('links an existing email-password account rather than duplicating it', async () => {
    const existing = await User.create({
      email: 'ada@example.com',
      authProvider: 'email',
      passwordHash: 'scrypt$65536$8$1$c2FsdA$aGFzaA',
      emailVerifiedAt: new Date(),
    });

    const linked = await findOrCreateGoogleUser(identity);

    expect(String(linked._id)).toBe(String(existing._id));
    expect(linked.googleSub).toBe('google-sub-1');
    // The password is left alone: the user can still sign in either way.
    const stored = await User.findById(linked._id).select('+passwordHash');
    expect(stored?.passwordHash).toBe('scrypt$65536$8$1$c2FsdA$aGFzaA');
  });

  it('verifies an unverified account it links to', async () => {
    // Google has proved the address, which is exactly what our own emailed link
    // proves — so someone who signed up, never clicked, then used Google is not
    // left stuck as unverified.
    const pending = await User.create({
      email: 'ada@example.com',
      authProvider: 'email',
      emailVerifiedAt: null,
    });
    const linked = await findOrCreateGoogleUser(identity);
    expect(String(linked._id)).toBe(String(pending._id));
    expect(linked.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('does not overwrite a name the user already chose', async () => {
    const existing = await User.create({
      email: 'ada@example.com',
      authProvider: 'email',
      name: 'A. Lovelace',
      emailVerifiedAt: new Date(),
    });
    const linked = await findOrCreateGoogleUser(identity);
    // Google's display name fills a gap; it does not win an argument.
    expect(linked.name).toBe('A. Lovelace');
    expect(String(linked._id)).toBe(String(existing._id));
  });

  it('fills in a missing name from Google', async () => {
    await User.create({ email: 'ada@example.com', authProvider: 'email', name: null });
    expect((await findOrCreateGoogleUser(identity)).name).toBe('Ada Lovelace');
  });

  it('keeps two Google identities separate', async () => {
    await findOrCreateGoogleUser(identity);
    await findOrCreateGoogleUser({ sub: 'google-sub-2', email: 'grace@example.com', name: null });
    expect(await User.countDocuments({})).toBe(2);
  });

  it('handles an identity with no name at all', async () => {
    // The `name` scope can be absent or empty; a nameless account is valid and
    // the emails fall back to a neutral greeting.
    const user = await findOrCreateGoogleUser({ sub: 's', email: 'x@example.com', name: null });
    expect(user.name).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  authLink,
  describeHours,
  escapeHtml,
  verifyEmailMessage,
  resetPasswordMessage,
  setPasswordMessage,
  accountExistsMessage,
  type EmailMessage,
} from './email-templates.js';

const HOUR = 3600;

describe('authLink', () => {
  it('builds a link with the token as a query parameter', () => {
    expect(authLink('https://app.example.com', 'verify-email', 'abc123')).toBe(
      'https://app.example.com/verify-email?token=abc123',
    );
  });

  /**
   * A trailing slash on APP_URL is the likeliest way this gets configured, and
   * naive concatenation would produce `//verify-email` — which some hosts serve
   * and some 404.
   */
  it('tolerates a trailing slash on the app URL', () => {
    expect(authLink('https://app.example.com/', 'reset-password', 'tok')).toBe(
      'https://app.example.com/reset-password?token=tok',
    );
  });

  it('encodes a token containing URL-significant characters', () => {
    const link = authLink('https://app.example.com', 'verify-email', 'a+b/c=d&e');
    // The point is round-tripping, not the exact escaping: whatever the encoder
    // emits, the receiving page must read back the original token.
    expect(new URL(link).searchParams.get('token')).toBe('a+b/c=d&e');
  });

  it('keeps a port and a base path from the app URL', () => {
    expect(authLink('http://localhost:3000', 'verify-email', 't')).toBe(
      'http://localhost:3000/verify-email?token=t',
    );
  });
});

describe('escapeHtml', () => {
  it('neutralises markup in an interpolated value', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  /**
   * Ampersand must be escaped first. Reversed, `<` becomes `&lt;` and then the
   * ampersand pass turns it into `&amp;lt;`, which renders as literal "&lt;".
   */
  it('does not double-escape its own output', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('escapes both quote characters, for use inside an attribute', () => {
    expect(escapeHtml(`" onload='x'`)).toBe('&quot; onload=&#39;x&#39;');
  });
});

describe('describeHours', () => {
  it('reads naturally at one hour and at many', () => {
    expect(describeHours(HOUR)).toBe('1 hour');
    expect(describeHours(24 * HOUR)).toBe('24 hours');
  });

  it('never claims zero hours', () => {
    // A sub-hour window would otherwise render as "0 hours", which reads as
    // already-expired.
    expect(describeHours(60)).toBe('1 hour');
    expect(describeHours(0)).toBe('1 hour');
  });
});

/** Every message must satisfy these, whatever else it says. */
function expectWellFormed(message: EmailMessage, url: string): void {
  expect(message.subject.length).toBeGreaterThan(0);
  // The link has to be in BOTH parts: a text-only client that cannot see the
  // HTML button is left with no way to continue.
  expect(message.html).toContain(url);
  expect(message.text).toContain(url);
  // No unreplaced placeholder left behind by a future edit.
  expect(message.html).not.toMatch(/\$\{|undefined|\[object/);
  expect(message.text).not.toMatch(/\$\{|undefined|\[object/);
}

describe('the link emails', () => {
  const url = 'https://app.example.com/verify-email?token=tok';

  it('addresses the recipient by name when there is one', () => {
    const message = verifyEmailMessage({
      to: 'a@example.com',
      name: 'Ada',
      url,
      expiresInSeconds: 24 * HOUR,
    });
    expect(message.text).toContain('Hi Ada,');
    expectWellFormed(message, url);
  });

  it('falls back to a neutral greeting for a nameless or blank-named account', () => {
    for (const name of [null, undefined, '   ']) {
      const message = verifyEmailMessage({
        to: 'a@example.com',
        name,
        url,
        expiresInSeconds: 24 * HOUR,
      });
      expect(message.text).toContain('Hi there,');
      expect(message.text).not.toContain('Hi ,');
    }
  });

  it('escapes a name containing markup', () => {
    const message = verifyEmailMessage({
      to: 'a@example.com',
      name: '<img src=x onerror=alert(1)>',
      url,
      expiresInSeconds: HOUR,
    });
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;img');
  });

  it('states the expiry window it was given', () => {
    expect(
      verifyEmailMessage({ to: 'a@example.com', url, expiresInSeconds: 24 * HOUR }).text,
    ).toContain('24 hours');
    expect(
      resetPasswordMessage({ to: 'a@example.com', url, expiresInSeconds: HOUR }).text,
    ).toContain('1 hour');
  });

  it('reassures a reset recipient who did not ask', () => {
    // The most common recipient of a reset email is someone who did not request
    // it, and their first question is whether their password has changed.
    const message = resetPasswordMessage({ to: 'a@example.com', url, expiresInSeconds: HOUR });
    expect(message.text).toContain('your password has not changed');
    expectWellFormed(message, url);
  });

  it('explains why a set-password email arrived at all', () => {
    // Someone who tried to sign in and got an email instead needs to know it is
    // not a rejection.
    const message = setPasswordMessage({ to: 'a@example.com', url, expiresInSeconds: HOUR });
    expect(message.text).toMatch(/does not have a password yet/);
    expectWellFormed(message, url);
  });
});

describe('accountExistsMessage', () => {
  const signInUrl = 'https://app.example.com/login';
  const resetUrl = 'https://app.example.com/forgot-password';

  it('offers both signing in and resetting', () => {
    const message = accountExistsMessage({ to: 'a@example.com', signInUrl, resetUrl });
    expect(message.text).toContain(signInUrl);
    expect(message.text).toContain(resetUrl);
    expect(message.html).toContain(resetUrl);
  });

  /**
   * This email is the whole enumeration defence: the person who submitted the
   * signup form learns nothing, and the account owner is told plainly that
   * nothing happened. Saying "account created" here would both mislead them and
   * defeat the point.
   */
  it('makes clear that nothing was created', () => {
    const message = accountExistsMessage({ to: 'a@example.com', signInUrl, resetUrl });
    expect(message.text).toContain('No account was created');
    expect(message.html).toContain('No account was created');
  });
});

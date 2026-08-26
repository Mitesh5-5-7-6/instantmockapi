import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  emailOrIpKey,
  LOGIN_LIMIT,
  SIGNUP_LIMIT,
  EMAIL_SEND_LIMIT,
  REDEEM_LIMIT,
  REFRESH_LIMIT,
} from './auth-rate-limits.js';

function request(body: unknown, ip = '10.0.0.1'): FastifyRequest {
  return { body, ip } as FastifyRequest;
}

describe('emailOrIpKey', () => {
  it('keys on the submitted email', () => {
    expect(emailOrIpKey(request({ email: 'ada@example.com' }))).toBe('email:ada@example.com');
  });

  /**
   * The point of keying on the account rather than the caller: an attacker with a
   * hundred addresses on a botnet would otherwise get a hundred separate budgets
   * against the same password.
   */
  it('gives one account one budget across many source IPs', () => {
    const a = emailOrIpKey(request({ email: 'ada@example.com' }, '10.0.0.1'));
    const b = emailOrIpKey(request({ email: 'ada@example.com' }, '203.0.113.9'));
    expect(a).toBe(b);
  });

  it('normalises case and surrounding whitespace', () => {
    // Otherwise "Ada@Example.com " is a fresh bucket for the same account, and
    // the limit is trivially bypassed by varying the capitalisation.
    expect(emailOrIpKey(request({ email: '  Ada@Example.COM ' }))).toBe('email:ada@example.com');
  });

  it('keys different accounts separately', () => {
    // One person failing to sign in must not lock out everyone else.
    expect(emailOrIpKey(request({ email: 'a@example.com' }))).not.toBe(
      emailOrIpKey(request({ email: 'b@example.com' })),
    );
  });

  it('falls back to the IP when there is no email to key on', () => {
    expect(emailOrIpKey(request({}))).toBe('ip:10.0.0.1');
    expect(emailOrIpKey(request(undefined))).toBe('ip:10.0.0.1');
    expect(emailOrIpKey(request({ email: '   ' }))).toBe('ip:10.0.0.1');
  });

  it('falls back to the IP for a non-string email', () => {
    // The key generator runs on a parsed body. Schema validation has usually
    // rejected this shape already, but a key generator that throws would turn a
    // malformed request into a 500.
    expect(emailOrIpKey(request({ email: { $ne: null } }))).toBe('ip:10.0.0.1');
    expect(emailOrIpKey(request({ email: 42 }))).toBe('ip:10.0.0.1');
    expect(emailOrIpKey(request({ email: ['a@b.com'] }))).toBe('ip:10.0.0.1');
  });
});

describe('the limit policies', () => {
  /**
   * The global limit is 100/min. Anything at or above that would be no limit at
   * all, so this asserts the credential routes are genuinely tighter.
   */
  it('are all stricter than the global 100/min', () => {
    const perMinute = (policy: { max: number; timeWindow: number }) =>
      policy.max / (policy.timeWindow / 60_000);
    for (const policy of [LOGIN_LIMIT, SIGNUP_LIMIT, EMAIL_SEND_LIMIT, REDEEM_LIMIT]) {
      expect(perMinute(policy)).toBeLessThan(100);
    }
  });

  it('leaves room for a person mistyping a password twice', () => {
    expect(LOGIN_LIMIT.max).toBeGreaterThanOrEqual(5);
    expect(LOGIN_LIMIT.timeWindow).toBe(60_000);
  });

  it('keys login and mail-sending on the account, not only the caller', () => {
    expect(LOGIN_LIMIT.keyGenerator).toBe(emailOrIpKey);
    expect(EMAIL_SEND_LIMIT.keyGenerator).toBe(emailOrIpKey);
  });

  /**
   * Signup and redemption inherit no key generator on purpose — and that matters,
   * because the *global* generator keys on the verified user id, which is null
   * on these routes, so both fall back to the IP. Signup has no account to key
   * on (that is the point), and a redemption request carries a token rather than
   * an email.
   */
  it('leaves signup and redemption keyed on the caller', () => {
    expect(SIGNUP_LIMIT.keyGenerator).toBeUndefined();
    expect(REDEEM_LIMIT.keyGenerator).toBeUndefined();
  });

  it('rations the outbound emails by the hour, not the minute', () => {
    // These send mail to an address the requester chooses, so an unbounded one
    // is a way to flood somebody's inbox using our sending domain.
    expect(EMAIL_SEND_LIMIT.timeWindow).toBe(3_600_000);
    expect(EMAIL_SEND_LIMIT.max).toBeLessThanOrEqual(3);
    expect(SIGNUP_LIMIT.timeWindow).toBe(3_600_000);
  });

  it('lets a working session refresh freely', () => {
    // With a 900s access token a single long-lived tab refreshes about four
    // times an hour; several tabs and a reload or two must not hit this.
    expect(REFRESH_LIMIT.max).toBeGreaterThan(LOGIN_LIMIT.max);
    expect(REFRESH_LIMIT.timeWindow).toBe(60_000);
  });
});

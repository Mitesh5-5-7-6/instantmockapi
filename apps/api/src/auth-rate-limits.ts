/**
 * Per-route rate limits for the credential endpoints (doc 13 §1).
 *
 * The global limit is 100/min keyed on the bearer token or IP
 * ([server.ts](./server.ts)). That is sized for an authenticated app doing
 * ordinary work, and it is far too generous for a login form: 100 password
 * guesses a minute is 144,000 a day against one account.
 *
 * Two things are tightened here.
 *
 * **The numbers**, per route, sized to what a real person does — nobody signs in
 * ten times in a minute, and nobody needs four password-reset emails in an hour.
 *
 * **The key.** The global generator falls back to the client IP, which lets an
 * attacker with a hundred IPs make a hundred times the attempts against one
 * account. Where the body names an email address, that address becomes part of
 * the key, so the budget follows the account being attacked rather than only the
 * machine attacking it.
 */

import type { FastifyRequest } from 'fastify';

/**
 * Rate-limit key: the target account when the request names one, else the IP.
 *
 * Keying on the email *instead of* the IP rather than in addition to it is
 * deliberate. Combining them would give each new IP its own fresh budget for the
 * same account, which is precisely the distributed attack this is meant to stop.
 * The global limiter still caps total traffic per IP, so neither dimension is
 * unbounded.
 */
export function emailOrIpKey(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return email === '' ? `ip:${request.ip}` : `email:${email}`;
}

interface LimitPolicy {
  max: number;
  timeWindow: number;
  keyGenerator?: (request: FastifyRequest) => string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Ten guesses a minute against one account.
 *
 * Enough that a person mistyping their password twice and then finding the right
 * one is never blocked; nowhere near enough for a dictionary.
 */
export const LOGIN_LIMIT: LimitPolicy = {
  max: 10,
  timeWindow: MINUTE,
  keyGenerator: emailOrIpKey,
};

/**
 * Five accounts an hour per IP.
 *
 * Keyed on IP, not email — the email is *unknown to us* on signup, which is the
 * whole point, so there is nothing else to key on. This is the limit that stops
 * a script from farming accounts.
 */
export const SIGNUP_LIMIT: LimitPolicy = {
  max: 5,
  timeWindow: HOUR,
};

/**
 * Three emails an hour, per address.
 *
 * These endpoints send mail to an address chosen by the requester, so an
 * unbounded one is a way to use us to flood somebody's inbox — a
 * reputation problem as much as an abuse problem, since it gets the sending
 * domain blocklisted.
 */
export const EMAIL_SEND_LIMIT: LimitPolicy = {
  max: 3,
  timeWindow: HOUR,
  keyGenerator: emailOrIpKey,
};

/**
 * Ten redemptions a minute per IP.
 *
 * A token is 32 random bytes, so guessing one is not the threat; this only stops
 * a client from hammering the endpoint. Keyed on IP because a redemption request
 * carries a token, not an email.
 */
export const REDEEM_LIMIT: LimitPolicy = {
  max: 10,
  timeWindow: MINUTE,
};

/** Refreshing is frequent and cheap, but not unlimited. */
export const REFRESH_LIMIT: LimitPolicy = {
  max: 30,
  timeWindow: MINUTE,
};

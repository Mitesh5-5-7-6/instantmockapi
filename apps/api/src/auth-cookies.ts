/**
 * The refresh-token cookie, and the CSRF guard it makes necessary (doc 13 §1).
 *
 * ## Why a cookie at all
 *
 * The access token lives in a JavaScript variable in the browser tab — never in
 * `localStorage`, so a cross-site scripting bug cannot read a durable credential
 * out of storage. But a variable dies on refresh, and something has to survive a
 * page load; that something must be unreadable by script. Hence an `HttpOnly`
 * cookie holding only the refresh token.
 *
 * ## What that costs
 *
 * The web app and the API are different origins — and on `*.vercel.app` the
 * public-suffix list makes them different *sites* — so the cookie has to be
 * `SameSite=None` to be sent at all. A cookie sent cross-site is exactly the
 * precondition for CSRF, so the endpoints that read it need their own defence.
 * That is `requireCsrfHeader` below.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { REFRESH_TOKEN_LIFETIME_SECONDS } from '@instantmockapi/auth';
import { AppError } from '@instantmockapi/shared';

export const REFRESH_COOKIE = 'imapi_rt';

/**
 * Scoped to the auth routes, not to `/`.
 *
 * Every other endpoint authenticates with a bearer header and has no use for
 * this cookie, so sending it on all of them would only widen the surface where
 * it can leak — into a log, a proxy, or an error report.
 */
export const REFRESH_COOKIE_PATH = '/v1/auth';

/**
 * Custom header the browser must send on cookie-authenticated requests.
 *
 * This is the entire CSRF defence, and it works by consequence rather than by
 * secrecy: a cross-origin request carrying a non-safelisted header triggers a
 * CORS preflight, and the preflight fails for any origin CORS does not allow. An
 * attacker's page therefore cannot make the browser send the request at all. A
 * form post or an `<img>` — neither of which can set a header — is refused here.
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'instantmockapi';

/**
 * Attributes, shared by set and clear.
 *
 * `Secure` is unconditional, including in development: browsers treat
 * `http://localhost` as a trustworthy origin, so a Secure cookie works there.
 * Making the flag conditional would buy nothing and leave the deployment one
 * misread environment variable away from a plaintext-transmissible session.
 *
 * No `Domain` attribute, so the cookie stays host-only rather than being shared
 * with sibling subdomains.
 */
const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  // `none` is forced by the cross-site deployment, not chosen. Browsers reject
  // SameSite=None without Secure, so the two travel together.
  sameSite: 'none' as const,
  path: REFRESH_COOKIE_PATH,
  // Not signed: the value is already a signed JWT, so a cookie signature would
  // authenticate the same bytes a second time.
  signed: false,
} as const;

/** Attach the refresh cookie to a response. */
export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    ...COOKIE_ATTRIBUTES,
    maxAge: REFRESH_TOKEN_LIFETIME_SECONDS,
  });
}

/**
 * Remove the refresh cookie.
 *
 * The attributes must match the ones it was set with — a browser treats
 * `Path=/v1/auth` and `Path=/` as different cookies, so clearing with the wrong
 * path leaves the original in place and the user still signed in.
 */
export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, COOKIE_ATTRIBUTES);
}

/** Read the refresh cookie, or null when absent or empty. */
export function readRefreshCookie(request: FastifyRequest): string | null {
  const value = request.cookies[REFRESH_COOKIE];
  return value === undefined || value === '' ? null : value;
}

/**
 * Refuse a cookie-authenticated request that does not carry the custom header.
 *
 * Registered as an `onRequest` hook on the cookie-reading routes. Deliberately
 * checks only presence and value — there is no secret to compare, because the
 * protection comes from the browser's preflight rather than from the header's
 * contents.
 */
export function requireCsrfHeader(request: FastifyRequest): void {
  const header = request.headers[CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== CSRF_HEADER_VALUE) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Missing or invalid request header',
    });
  }
}

/**
 * Google sign-in, server side (doc 13 §6).
 *
 * **No new dependency.** `jose` is already here for our own JWTs, and its
 * `createRemoteJWKSet` is exactly what verifying a Google `id_token` needs; the
 * code exchange is one `fetch`. An OAuth library would add a dependency to do
 * these two things.
 *
 * The three checks that matter, and what each one prevents:
 *
 * 1. **`aud` is our client id.** Without it, an `id_token` minted for *any other*
 *    Google application is accepted here — and those are handed out freely, so
 *    anyone with their own Google app could sign in as anyone.
 * 2. **`iss` is Google.** The signature check already implies this via the JWKS,
 *    but asserting it keeps the guarantee explicit rather than incidental.
 * 3. **`email_verified` is true.** Google accounts can carry an address the owner
 *    never proved — so without this, someone could claim an existing
 *    InstantMockAPI account by adding its address to their own Google profile.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, logger } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Fail rather than hold a request open on a slow Google. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Created once, at module scope.
 *
 * `createRemoteJWKSet` caches Google's signing keys and refetches on rotation.
 * Building it per request would mean an extra HTTPS round trip on every sign-in
 * and would throw away the cache that makes key rotation cheap.
 */
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

interface TokenResponse {
  id_token?: string;
}

/** One message for every failure — the client can do nothing useful with more. */
function rejected(): AppError {
  return new AppError({
    code: 'UNAUTHORIZED',
    message: 'Google sign-in could not be completed',
  });
}

/**
 * Exchange the authorization code for an `id_token` and verify it.
 *
 * The `code_verifier` is what makes an intercepted code useless: Google checks it
 * against the challenge sent before the redirect, so a code lifted from a
 * referrer header or a shared screen cannot be redeemed without the verifier that
 * never left the user's tab.
 */
export async function verifyGoogleCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: EnvConfig,
): Promise<GoogleIdentity> {
  if (config.googleClientId === '' || config.googleClientSecret === '') {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: 'Google sign-in is not configured on this deployment',
    });
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error('Google token exchange failed to complete', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw rejected();
  }

  if (!response.ok) {
    // Logged, not returned: Google's message here names the client id and the
    // redirect URI, which belong in our logs and not in a response body.
    const detail = await response.text().catch(() => '');
    logger.warn('Google rejected the code exchange', {
      status: response.status,
      detail: detail.slice(0, 300),
    });
    throw rejected();
  }

  const body = (await response.json()) as TokenResponse;
  if (typeof body.id_token !== 'string') {
    throw rejected();
  }

  let claims: Record<string, unknown>;
  try {
    // `audience` and `issuer` are enforced by jwtVerify itself — passing them is
    // what makes the check unskippable, rather than something to remember to do
    // afterwards.
    const verified = await jwtVerify(body.id_token, jwks, {
      audience: config.googleClientId,
      issuer: ISSUERS,
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (error) {
    logger.warn('Google id_token failed verification', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw rejected();
  }

  const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
  const email = typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : '';
  const emailVerified = claims['email_verified'] === true;
  const name = typeof claims['name'] === 'string' ? claims['name'] : null;

  if (sub === '' || email === '') {
    throw rejected();
  }
  if (!emailVerified) {
    // The check that stops an unverified Google address from claiming an existing
    // account here.
    throw new AppError({
      code: 'UNAUTHORIZED',
      message: 'Confirm your email address with Google before signing in',
    });
  }

  return { sub, email, name };
}

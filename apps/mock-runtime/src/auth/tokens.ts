/**
 * Signing and verifying tokens for a **generated** mock API (Phase 3 §7, §8, §14).
 *
 * ## This is deliberately not `packages/auth/tokens.ts`
 *
 * That module signs platform sessions: it uses the platform's `jwtSecret`, mints
 * platform claims (`plan`, `tokenVersion`) and its tokens open every project the
 * signed-in user owns. The endpoint names here are the same five words, which is
 * exactly why the temptation to reuse it exists and exactly why it must be
 * resisted — reusing that signer would make signing up to a stranger's mock todo
 * API a route to a project-owner session. That is privilege escalation, not the
 * cross-project leak §14 names.
 *
 * The two share `jose` and nothing else. No key, no claim set, no verifier.
 *
 * ## Isolation is structural
 *
 * Each project signs with its own key (`ensureAuthSecret`). A token minted for
 * project A fails project B's signature check before any claim is read, so §14's
 * "do not allow a token from Project A to authenticate against Project B" is not
 * a check that could be forgotten. The `aud` claim carries the project id anyway
 * and is verified, because defence in depth costs one line and a mistake here is
 * silent.
 *
 * ## Minimal claims
 *
 * §7 asks for `sub`, `type`, `iat`, `exp` and no more. Nothing about the user
 * beyond their id goes in: a JWT is readable by anyone holding it, and an email
 * in the payload is an email in every log and proxy that ever sees the header.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * `type` distinguishes an access token from a refresh token.
 *
 * Both are signed with the same key, so without this a refresh token would be
 * accepted as an access token — it verifies, it has a `sub`, and it lives seven
 * days rather than fifteen minutes. That is the single most common JWT mistake
 * and the reason §7 lists `type` among the required claims.
 */
export type MockTokenType = 'access' | 'refresh';

export interface MockTokenClaims {
  /** The `MockUser` id. */
  sub: string;
  type: MockTokenType;
  /** The project the token is for, verified as the audience. */
  projectId: string;
  /** Seconds since the epoch, as issued. */
  iat: number;
  exp: number;
}

const ALGORITHM = 'HS256';

/** `15m`, `7d`, `900s` — the grammar `validateIPS` enforces on the config. */
const DURATION = /^([1-9][0-9]*)(s|m|h|d)$/;

const SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Duration string to seconds.
 *
 * Falls back rather than throwing, because this reads a *stored* configuration:
 * a historical document with a value written before the grammar was enforced
 * must still be servable. `validateIPS` is what stops a new one being written.
 */
export function durationSeconds(value: string, fallbackSeconds: number): number {
  const match = DURATION.exec(value);
  if (match === null) {
    return fallbackSeconds;
  }
  return Number(match[1]) * (SECONDS[match[2]!] ?? 1);
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface SignedToken {
  token: string;
  /** When it stops verifying, for the caller to store or return. */
  expiresAt: Date;
}

export async function signMockToken(params: {
  secret: string;
  projectId: string;
  userId: string;
  type: MockTokenType;
  ttlSeconds: number;
}): Promise<SignedToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expires = issuedAt + params.ttlSeconds;

  const token = await new SignJWT({ type: params.type })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(params.userId)
    // The project id as audience, so verification rejects a foreign token even
    // in the impossible case of two projects sharing a key.
    .setAudience(params.projectId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(keyOf(params.secret));

  return { token, expiresAt: new Date(expires * 1000) };
}

export type VerifyFailure = 'malformed' | 'signature' | 'expired' | 'wrong-audience' | 'wrong-type';

export type VerifyResult =
  { ok: true; claims: MockTokenClaims } | { ok: false; reason: VerifyFailure };

/**
 * Verify a token for one project and one purpose.
 *
 * Returns a reason rather than throwing, and the caller turns every one of them
 * into the same 401 (§14). The distinction exists for logs and for the §21
 * tester, never for the response body: telling a caller *why* their token failed
 * tells an attacker which half of a forgery attempt worked.
 */
export async function verifyMockToken(params: {
  secret: string;
  projectId: string;
  token: string;
  expect: MockTokenType;
}): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(params.token, keyOf(params.secret), {
      algorithms: [ALGORITHM],
      audience: params.projectId,
    });

    if (payload['type'] !== params.expect) {
      // A refresh token presented as an access token verifies perfectly and
      // lives 7 days rather than 15 minutes. This is the check that matters.
      return { ok: false, reason: 'wrong-type' };
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      return { ok: false, reason: 'malformed' };
    }

    return {
      ok: true,
      claims: {
        sub: payload.sub,
        type: params.expect,
        projectId: params.projectId,
        iat: payload.iat,
        exp: payload.exp,
      },
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired' };
    }
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      // Audience mismatch: a token minted for another project, in the case
      // where the signature somehow held.
      return { ok: false, reason: 'wrong-audience' };
    }
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: 'signature' };
    }
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * The bearer token on a request, or null.
 *
 * §23 forbids tokens in URLs, so the query string is deliberately not consulted
 * — a token in a URL ends up in access logs, browser history and referrers.
 * Cookie mode is handled separately by the caller, which is the only other
 * place a credential may come from.
 */
export function bearerToken(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

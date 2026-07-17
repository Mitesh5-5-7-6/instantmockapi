/**
 * JWT issuance and verification (doc 13 §1).
 *
 * HS256 access tokens (short-lived, lifetime from `JWT_EXPIRES_IN`) plus
 * longer-lived refresh tokens. Both carry the same claims; a `tokenType`
 * claim prevents a refresh token from being used as an access token.
 */

import { SignJWT, jwtVerify } from 'jose';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { AppError, PLAN_TIERS, type PlanTier, type Result, ok, err } from '@instantmockapi/shared';

export type TokenType = 'access' | 'refresh';

/** Identity snapshot embedded in tokens. */
export interface AuthUser {
  /** User id (Mongo ObjectId hex string) — becomes the JWT `sub`. */
  id: string;
  email: string;
  plan: PlanTier;
}

/** Verified claims extracted from a token. */
export interface AuthTokenClaims {
  /** Token subject: the user id. Ownership checks compare against this (doc 13 §2). */
  sub: string;
  email: string;
  plan: PlanTier;
  tokenType: TokenType;
}

/** Refresh tokens outlive access tokens; 30 days pending a session store. */
export const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function signingKey(config: EnvConfig): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

async function signToken(
  user: AuthUser,
  tokenType: TokenType,
  lifetimeSeconds: number,
  config: EnvConfig,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: user.email, plan: user.plan, tokenType })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + lifetimeSeconds)
    .sign(signingKey(config));
}

/** Issue a short-lived access token for an authenticated user. */
export async function issueAccessToken(
  user: AuthUser,
  config: EnvConfig = loadEnvConfig(),
): Promise<string> {
  return signToken(user, 'access', config.jwtExpiresIn, config);
}

/** Issue a refresh token used to obtain new access tokens. */
export async function issueRefreshToken(
  user: AuthUser,
  config: EnvConfig = loadEnvConfig(),
): Promise<string> {
  return signToken(user, 'refresh', REFRESH_TOKEN_LIFETIME_SECONDS, config);
}

function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

function unauthorized(message: string): AppError {
  return new AppError({ code: 'UNAUTHORIZED', message });
}

/**
 * Verify a token's signature, expiry, and claim shape.
 * Returns UNAUTHORIZED for any failure — callers never learn why a token
 * was rejected beyond "invalid or expired".
 */
export async function verifyToken(
  token: string,
  expectedType: TokenType,
  config: EnvConfig = loadEnvConfig(),
): Promise<Result<AuthTokenClaims, AppError>> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, signingKey(config));
    payload = verified.payload;
  } catch {
    return err(unauthorized('Invalid or expired token'));
  }

  const sub = payload['sub'];
  const email = payload['email'];
  const plan = payload['plan'];
  const tokenType = payload['tokenType'];

  if (typeof sub !== 'string' || !sub || typeof email !== 'string' || !isPlanTier(plan)) {
    return err(unauthorized('Token is missing required claims'));
  }
  if (tokenType !== expectedType) {
    return err(unauthorized(`Expected ${expectedType} token`));
  }

  return ok({ sub, email, plan, tokenType: expectedType });
}

/** Verify an access token (the `Authorization: Bearer` credential). */
export function verifyAccessToken(
  token: string,
  config?: EnvConfig,
): Promise<Result<AuthTokenClaims, AppError>> {
  return verifyToken(token, 'access', config);
}

/** Verify a refresh token (presented to `POST /v1/auth/refresh`). */
export function verifyRefreshToken(
  token: string,
  config?: EnvConfig,
): Promise<Result<AuthTokenClaims, AppError>> {
  return verifyToken(token, 'refresh', config);
}

/** Extract the raw token from an `Authorization: Bearer <jwt>` header. */
export function extractBearerToken(header: string | undefined): Result<string, AppError> {
  if (!header || !header.startsWith('Bearer ')) {
    return err(unauthorized('Missing bearer token'));
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return err(unauthorized('Missing bearer token'));
  }
  return ok(token);
}

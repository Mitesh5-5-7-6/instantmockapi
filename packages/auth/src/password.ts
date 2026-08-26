/**
 * Password hashing (doc 13 §1).
 *
 * **scrypt from `node:crypto`, not bcrypt or argon2.** That is a deployment
 * constraint rather than a preference: both of those are native modules that
 * routinely fail to build on serverless platforms, and `apps/api` deploys to
 * Vercel functions. scrypt is an OWASP-accepted KDF, ships in the standard
 * library, and needs no dependency at all.
 *
 * The cost parameters are stored **inside** the hash string, PHC-style, so they
 * can be raised later without invalidating a single existing password — an old
 * hash still verifies against the parameters it was created with, and
 * `needsRehash` reports when it is worth upgrading on next sign-in.
 *
 *   scrypt$N$r$p$salt$hash        (salt and hash base64url)
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` resolves to `scrypt`'s first overload, which takes no options
 * object — so the signature is restated here to reach the one that accepts cost
 * parameters. Without this the call typechecks as "expected 3 arguments".
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** Current cost. N=2^16 needs 64MB per hash — heavy enough to matter, light
 *  enough for a serverless invocation, and logins are rate-limited anyway. */
const N = 65536;
const R = 8;
const P = 1;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Bounds on what a *stored* hash may ask for.
 *
 * These exist for a specific attack: scrypt's memory cost is `128 * N * r`, so a
 * tampered or injected hash claiming `N = 2^30` would make one verification try
 * to allocate gigabytes. Parsing rejects anything outside these bounds rather
 * than trusting the numbers it just read out of the database.
 */
const MIN_N = 16384; // 2^14
const MAX_N = 1_048_576; // 2^20
const MAX_R = 32;
const MAX_P = 16;

/** scrypt needs `maxmem >= 128 * N * r`; Node's default of 32MB is too low. */
function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

async function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  // Normalized before hashing: the same password typed on two devices can arrive
  // as different byte sequences (é as one code point vs e + combining accent),
  // and would otherwise fail to match.
  const normalized = password.normalize('NFKC');
  return scryptAsync(normalized, salt, KEY_BYTES, {
    N: n,
    r,
    p,
    maxmem: maxmemFor(n, r),
  });
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/**
 * Parse a stored hash, or `null` if it is not one we can safely use.
 *
 * Total by design — a malformed or hostile value returns null rather than
 * throwing, so a corrupt row fails one sign-in instead of 500-ing the endpoint.
 */
function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!isPowerOfTwo(n) || n < MIN_N || n > MAX_N) {
    return null;
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) {
    return null;
  }
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) {
    return null;
  }

  const salt = Buffer.from(parts[4] as string, 'base64url');
  const key = Buffer.from(parts[5] as string, 'base64url');
  if (salt.length === 0 || key.length === 0) {
    return null;
  }
  return { n, r, p, salt, key };
}

/**
 * Check a password against a stored hash.
 *
 * Never throws and never distinguishes *why* it failed — a wrong password, a
 * malformed hash and an unsupported cost all return `false`, because the caller
 * must not turn any of them into a different response.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, and the length of a stored hash
  // is not secret, so compare it first.
  if (derived.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.key);
}

/**
 * Whether a stored hash was made with weaker parameters than we now use.
 *
 * The caller has the plaintext at sign-in time, which is the only moment a
 * rehash is possible — so this is checked there and the hash quietly upgraded.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) {
    // Unparseable counts as needing replacement, though such a user cannot sign
    // in to trigger one.
    return true;
  }
  return parsed.n < N || parsed.r < R || parsed.p < P;
}

/** Current cost parameters, exposed for tests and diagnostics. */
export const PASSWORD_COST = { N, r: R, p: P, keyBytes: KEY_BYTES } as const;

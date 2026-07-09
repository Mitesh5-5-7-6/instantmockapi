/**
 * Result type for operations that can succeed or fail.
 *
 * Forces callers to handle both cases instead of relying on thrown exceptions.
 * Used by parsers, generators, and validators to return structured outcomes.
 */

/** Successful result carrying a value. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed result carrying an error. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** A discriminated union: either Ok<T> or Err<E>. */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/** Create a successful result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Create a failed result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Unwrap a Result, throwing the error if it failed.
 * Use sparingly — prefer pattern matching with `if (result.ok)`.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * Ownership checks (doc 13 §2).
 *
 * Every project operation verifies `project.ownerId === token.sub`.
 * Failures surface as NOT_FOUND (404) rather than FORBIDDEN so cross-tenant
 * probing cannot confirm that a resource exists.
 */

import { AppError, type Result, ok, err } from '@instantmockapi/shared';

/** Anything with a canonical string form — covers Mongo ObjectIds without a mongoose dependency. */
type IdLike = string | { toString(): string };

/** True when the resource owner matches the token subject. */
export function isOwner(ownerId: IdLike, tokenSub: string): boolean {
  return String(ownerId) === tokenSub;
}

/**
 * Assert ownership, yielding a 404-shaped error on mismatch so responses
 * do not leak resource existence to non-owners.
 */
export function assertOwnership(
  ownerId: IdLike,
  tokenSub: string,
  resourceName = 'Resource',
): Result<true, AppError> {
  if (isOwner(ownerId, tokenSub)) {
    return ok(true);
  }
  return err(new AppError({ code: 'NOT_FOUND', message: `${resourceName} not found` }));
}

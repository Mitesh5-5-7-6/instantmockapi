/**
 * Credential-attempt throttling (Phase 3 §23).
 *
 * §23 says to use the existing rate-limiting infrastructure for `/signIn`,
 * `/signUp` and `/refresh`, and that is exactly what this does — it supplies a
 * key and a ceiling to the one `@fastify/rate-limit` registration the runtime
 * already has, rather than adding a second limiter.
 *
 * ## Why the auth endpoints cannot share the project bucket
 *
 * The project-wide limit exists so a public hosted URL is not an unbounded
 * traffic sink. It is keyed on the **project** and set to 200/minute. Applied to
 * signIn that is wrong twice over:
 *
 * - 200 password guesses a minute is not a throttle.
 * - Worse, the guesses come out of the project's *shared* allowance, so an
 *   attacker brute-forcing one account also denies service to every legitimate
 *   caller of that API. The defence would be the attack.
 *
 * So credential attempts get their own namespace, keyed per **caller IP per
 * project**, at a much lower ceiling. One attacker's IP can then exhaust only
 * its own budget.
 *
 * ## One bucket for all three endpoints
 *
 * `/signUp`, `/signIn` and `/refresh` share a key. They are all credential
 * operations against the same account space, and a bucket each would simply
 * hand an attacker three times the budget for rotating between them.
 */

import { parseHostedPath } from '../path.js';
import type { AuthEndpointName } from '@instantmockapi/ips';

/**
 * The three §23 names.
 *
 * `/me` and `/logout` are deliberately absent. Neither can be used to guess a
 * credential — `/me` reads one that already verified and `/logout` accepts an
 * invalid token with a 204 — so throttling them would only break a client that
 * polls its own session, and would do so under the *credential* budget.
 */
const THROTTLED: ReadonlySet<AuthEndpointName> = new Set(['signup', 'signin', 'refresh']);

/**
 * The rate-limit key for a credential attempt, or null for anything else.
 *
 * `resolvePublicId` canonicalises a pretty URL to its project id, mirroring what
 * the project-wide key generator already does and for the same reason: both URL
 * forms address one project, so keying on the raw segment would let a caller
 * double their allowance by alternating `/p/{id}/signIn` and
 * `/p/{publicId}/{slug}/signIn`. A cold process that cannot resolve yet falls
 * back to the raw public id, which is the same imprecision the existing
 * generator documents and accepts.
 */
export function authAttemptKey(
  url: string,
  ip: string,
  resolvePublicId: (publicId: string) => string | null,
): string | null {
  const target = parseHostedPath(url);
  if (target === null || target.kind !== 'auth' || !THROTTLED.has(target.endpoint)) {
    return null;
  }

  const project =
    target.ref.form === 'legacy'
      ? target.ref.projectId.toLowerCase()
      : (resolvePublicId(target.ref.publicId) ?? target.ref.publicId);

  // No endpoint in the key: one shared credential budget, per the docstring.
  return `auth:${project}:${ip}`;
}

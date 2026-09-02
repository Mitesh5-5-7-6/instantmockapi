/**
 * The public routing identity of an entity — the one place `Entity name → URL`
 * is decided.
 *
 * ## Why this is its own module
 *
 * An entity has two identities, and they are not the same thing:
 *
 * - **Internal identity** — `ent_9a3c…`, stable across renames. What the
 *   dependency graph keys on.
 * - **Public identity** — the path segment a caller types. What every URL, every
 *   OpenAPI path, every Postman request and every stored traffic log contains.
 *
 * Today the second is derived from `entity.name`, so renaming an entity moves
 * its URLs. That is a real product decision, not an accident, and it is why
 * `ENTITY_RENAMED` carries the `ROUTING` risk level. But the derivation had been
 * re-implemented independently in six places, which is six chances for the
 * runtime and the documentation describing it to disagree — and a mismatch there
 * means the docs advertise a URL the runtime answers 404 on. Nobody debugging
 * that would suspect a `toLowerCase()`.
 *
 * ## Where the future goes
 *
 * When entities gain a route-stable slug — `name: 'Client'` serving at
 * `/customers`, so internal identity can change while public identity does not —
 * this function grows one branch and every caller inherits it. That is the whole
 * purpose of the seam. Nothing else needs to know.
 *
 * ## What does NOT belong here
 *
 * Generated **filenames** (`user.types.ts`, `user.zod.ts`, `user.mock.json`) also
 * lowercase the entity name, and they are deliberately left alone. A filename is
 * not a URL: coupling them would mean a future slug silently renamed files inside
 * every export ZIP, breaking imports in checked-in code to fix a routing concern.
 */

/** The minimum an entity must expose to have a route. */
export interface RoutableEntity {
  name: string;
}

/**
 * The public path segment for an entity — `User` → `user`, `OrderItem` →
 * `orderitem`.
 *
 * Lowercased and otherwise unmodified. Deliberately not kebab-cased,
 * pluralised, or URL-escaped: every project already hosted was generated under
 * this exact rule, and changing it would move live URLs for existing users. A
 * nicer scheme belongs behind an explicit opt-in slug, not behind a silent
 * change to what this returns.
 *
 * Callers add their own leading slash. The bare segment is what the hosted
 * runtime matches on and what `ApiLog.entity` stores, so returning it unadorned
 * keeps those joins direct.
 */
export function entitySlug(entity: RoutableEntity): string {
  return entity.name.toLowerCase();
}

/**
 * Hosted-URL grammar (doc 19 §Phase 3).
 *
 * Two URL forms resolve, and both are defined here so the runtime parser, the
 * worker that stamps `hosted.url`, the API serializers, and the docs generators
 * cannot drift apart:
 *
 *   legacy  /p/{24-hex ObjectId}/{entity}          — every URL issued before slugs
 *   pretty  /p/{prj_7d5e9a2f1c}/{slug}/{entity}    — what gets advertised
 *
 * The two are distinguishable from the **first segment alone**: a 24-hex ObjectId
 * can never contain `_`, and a `prj_`/`sng_` id can never be 24 hex characters.
 * That disjointness is what lets one wildcard route serve both shapes with no
 * lookahead and no database access.
 */

/** Public-id prefix per project kind. */
export const PUBLIC_ID_PREFIX = { project: 'prj', single: 'sng', auth: 'aut' } as const;

/**
 * What a project generates.
 *
 * - `project` — several entities with relationships between them.
 * - `single` — one focused resource.
 * - `auth` — the Auth API on its own: sign-up, sign-in, refresh, me, logout and
 *   nothing else (Phase 3). It has **no entities**, which is why `validateIPS`
 *   waives its "at least one entity" rule for this kind alone.
 *
 * An auth-only project is a real thing to want: a front end being built against
 * a login flow does not need a product catalogue to exercise it, and adding a
 * throwaway entity just to satisfy a validator would put a fake resource in the
 * generated docs.
 */
export type ProjectKind = keyof typeof PUBLIC_ID_PREFIX;

export const PROJECT_KINDS = ['project', 'single', 'auth'] as const;

/** 24-hex Mongo ObjectId — the legacy, still-supported id form. */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * Public routing id: `prj_`/`sng_` plus lowercase hex.
 *
 * Minimum 7 hex characters so ids minted at any length keep resolving, but new
 * ids are longer by default: 16^7 is only 268M values, which reaches a 50%
 * birthday-collision chance at ~19k projects — correct but a hot retry loop.
 */
export const PUBLIC_ID_PATTERN = /^(prj|sng|aut)_[0-9a-f]{7,16}$/;

/** Vanity path segment: kebab-case, 1–60 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs that would shadow a runtime or platform path. */
export const RESERVED_SLUGS: readonly string[] = [
  'p',
  'api',
  'v1',
  'health',
  'auth',
  'admin',
  '_meta',
];

export const SLUG_MAX_LENGTH = 60;

/** Enough of a project to address it. */
export interface HostedRef {
  projectId: string;
  publicId?: string | null;
  slug?: string | null;
}

/**
 * Path under the hosted base URL — the pretty form when both parts exist,
 * otherwise the legacy id.
 */
export function hostedPath(ref: HostedRef): string {
  return ref.publicId && ref.slug ? `${ref.publicId}/${ref.slug}` : ref.projectId;
}

/** Full hosted base URL for a project. */
export function hostedUrl(baseUrl: string, ref: HostedRef): string {
  return `${baseUrl.replace(/\/+$/, '')}/${hostedPath(ref)}`;
}

/**
 * Derive a URL-safe slug from a display name.
 *
 * Returns `fallback` when nothing usable survives (an all-punctuation name, or a
 * name that reduces to a reserved word).
 */
export function slugify(input: string, fallback = 'api'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug !== '' && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.includes(slug) ? slug : fallback;
}

/** Whether a slug is structurally acceptable and not reserved. */
export function isUsableSlug(slug: string): boolean {
  return (
    slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.includes(slug)
  );
}

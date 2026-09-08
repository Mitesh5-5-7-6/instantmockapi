/**
 * Hosted-path parsing (doc 19 §Phase 3).
 *
 * Pure: URL string in, target out, no database and no I/O. Fastify cannot
 * register `/p/:a/:b/:c` twice, so both URL shapes are served by a single
 * wildcard route and disambiguated here.
 *
 * The grammar, by arity of the segments after `/p/`:
 *
 * | segments | first segment | meaning                                   |
 * |----------|---------------|-------------------------------------------|
 * | 1        | 24-hex        | index (legacy base URL)                   |
 * | 2        | 24-hex        | {projectId}/{entity}                      |
 * | 3        | 24-hex        | {projectId}/{entity}/{recordId}           |
 * | ≥4       | 24-hex        | 404                                       |
 * | 1        | prj_/sng_     | 404 — the slug segment is required        |
 * | 2        | prj_/sng_     | index ({publicId}/{slug})                 |
 * | 3        | prj_/sng_     | {publicId}/{slug}/{entity}                |
 * | 4        | prj_/sng_     | {publicId}/{slug}/{entity}/{recordId}     |
 * | ≥5       | prj_/sng_     | 404 (endpoint mode arrives with Phase 7)  |
 * | any      | neither       | 404                                       |
 *
 * Arity-2 pretty is the **index**, never a slug-less collection: accepting both
 * would make `{slug}` and `{entity}` ambiguous whenever an entity name happens to
 * equal the slug.
 */

import { OBJECT_ID_PATTERN, PUBLIC_ID_PATTERN } from '@instantmockapi/shared';
import { RESERVED_ENTITY_NAMES, type AuthEndpointName } from '@instantmockapi/ips';

/** How a request addressed its project. */
export type HostedRefInput =
  { form: 'legacy'; projectId: string } | { form: 'pretty'; publicId: string; slug: string };

/**
 * The Auth API's five endpoints (Phase 3 §4).
 *
 * At the root of the hosted API rather than under an `/auth/` prefix, because
 * §4 names them `POST /signUp`, `POST /signIn`, `POST /refresh`, `GET /me`,
 * `POST /logout` and that shape reaches the generated OpenAPI and Postman
 * collection. Nesting them would put this file's convenience ahead of the
 * documented contract.
 *
 * The cost is a namespace shared with entities, which `validateIPS` handles by
 * reserving these five names when authentication is enabled — a visible error
 * at authoring time rather than a route that resolves to the wrong handler.
 */
export { AUTH_ENDPOINT_NAMES as AUTH_ENDPOINTS, RESERVED_ENTITY_NAMES } from '@instantmockapi/ips';

export type AuthEndpoint = AuthEndpointName;

/**
 * Matched case-insensitively.
 *
 * §4 writes `/signUp` in camelCase while `entitySlug` lowercases, so
 * `/signup` and `/signUp` would otherwise be two different routes — one the
 * Auth API and one an entity called `Signup`. That is a trap nobody would find
 * by reading either the spec or their own schema, so both spellings resolve
 * here and the name is reserved in both.
 */
function authEndpointOf(segment: string): AuthEndpoint | null {
  const lowered = segment.toLowerCase();
  return RESERVED_ENTITY_NAMES.has(lowered) ? (lowered as AuthEndpoint) : null;
}

export type HostedTarget =
  | { ref: HostedRefInput; kind: 'index' }
  | { ref: HostedRefInput; kind: 'auth'; endpoint: AuthEndpoint }
  | { ref: HostedRefInput; kind: 'collection'; entity: string }
  | { ref: HostedRefInput; kind: 'record'; entity: string; recordId: string };

const PREFIX = '/p';

/** Strip query/hash, split on `/`, drop empties, and percent-decode each part. */
function segmentsOf(pathname: string): string[] | null {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] ?? '';
  const parts = withoutQuery.split('/').filter((part) => part !== '');
  if (parts.length === 0 || parts[0] !== 'p') {
    return null;
  }
  const decoded: string[] = [];
  for (const part of parts.slice(1)) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      return null; // malformed escape → 404, never a 500
    }
  }
  return decoded;
}

/**
 * The first segment after `/p/`, without validating it.
 *
 * Used by the rate limiter, which must derive a bucket key synchronously and
 * cannot afford the full parse.
 */
export function firstHostedSegment(url: string): string | null {
  const segments = segmentsOf(url);
  return segments && segments.length > 0 ? (segments[0] ?? null) : null;
}

/** Parse a hosted URL path into a target, or null when nothing can serve it. */
export function parseHostedPath(pathname: string): HostedTarget | null {
  const segments = segmentsOf(pathname);
  if (!segments || segments.length === 0) {
    return null;
  }

  const first = segments[0]!;

  if (OBJECT_ID_PATTERN.test(first)) {
    const ref: HostedRefInput = { form: 'legacy', projectId: first };
    switch (segments.length) {
      case 1:
        return { ref, kind: 'index' };
      case 2: {
        // Auth before entities: these five names are reserved when
        // authentication is on, so an entity can never reach this branch under
        // one of them.
        const endpoint = authEndpointOf(segments[1]!);
        return endpoint === null
          ? { ref, kind: 'collection', entity: segments[1]! }
          : { ref, kind: 'auth', endpoint };
      }
      case 3:
        return { ref, kind: 'record', entity: segments[1]!, recordId: segments[2]! };
      default:
        return null;
    }
  }

  if (PUBLIC_ID_PATTERN.test(first)) {
    if (segments.length < 2) {
      return null; // the slug segment is part of the advertised base URL
    }
    const ref: HostedRefInput = { form: 'pretty', publicId: first, slug: segments[1]! };
    switch (segments.length) {
      case 2:
        return { ref, kind: 'index' };
      case 3: {
        const endpoint = authEndpointOf(segments[2]!);
        return endpoint === null
          ? { ref, kind: 'collection', entity: segments[2]! }
          : { ref, kind: 'auth', endpoint };
      }
      case 4:
        return { ref, kind: 'record', entity: segments[2]!, recordId: segments[3]! };
      default:
        return null;
    }
  }

  return null;
}

/** Rebuild the path prefix a target was addressed through, for error guidance. */
export function refPath(ref: HostedRefInput): string {
  return ref.form === 'legacy'
    ? `${PREFIX}/${ref.projectId}`
    : `${PREFIX}/${ref.publicId}/${ref.slug}`;
}

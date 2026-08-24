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

/** How a request addressed its project. */
export type HostedRefInput =
  { form: 'legacy'; projectId: string } | { form: 'pretty'; publicId: string; slug: string };

export type HostedTarget =
  | { ref: HostedRefInput; kind: 'index' }
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
      case 2:
        return { ref, kind: 'collection', entity: segments[1]! };
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
      case 3:
        return { ref, kind: 'collection', entity: segments[2]! };
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

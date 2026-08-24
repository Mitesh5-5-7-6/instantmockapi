/**
 * Process-local `publicId → projectId` index (doc 19 §Phase 3).
 *
 * The rate limiter must produce a bucket key **synchronously**, before any route
 * handler runs, but a pretty URL only carries the public id. Resolution writes
 * the mapping here so the limiter can canonicalise the key with a Map lookup
 * instead of a database round trip.
 *
 * Deliberately not a hash of the ObjectId: a hash collision would merge two
 * unrelated projects into one rate bucket, which is precisely the noisy-neighbour
 * failure this exists to prevent. A cold process simply keys on the raw public id
 * for the first request — the only imprecision, and it is per-process.
 */

const MAX_ENTRIES = 5_000;
const TTL_MS = 5 * 60 * 1_000;

interface Entry {
  projectId: string;
  expiresAt: number;
}

const index = new Map<string, Entry>();

/** Record the canonical project id behind a public id. */
export function rememberPublicId(publicId: string | null | undefined, projectId: string): void {
  if (!publicId) {
    return;
  }
  // Bounded, insertion-ordered eviction: Map preserves insert order, so the
  // oldest key is the first one iterated.
  if (index.size >= MAX_ENTRIES && !index.has(publicId)) {
    const oldest = index.keys().next();
    if (!oldest.done) {
      index.delete(oldest.value);
    }
  }
  index.set(publicId, { projectId, expiresAt: Date.now() + TTL_MS });
}

/** Canonical project id for a public id, or null when not seen recently. */
export function lookupPublicId(publicId: string): string | null {
  const entry = index.get(publicId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    index.delete(publicId);
    return null;
  }
  return entry.projectId;
}

/** Test seam. */
export function clearPublicIdIndex(): void {
  index.clear();
}

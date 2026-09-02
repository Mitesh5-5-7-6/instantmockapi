/**
 * Which version the hosted runtime serves (Phase 1).
 *
 * ## The bug this exists to fix
 *
 * `currentVersion` used to mean two different things at once — the version of the
 * definition a user edits, *and* the version the runtime resolves artifacts for.
 * Because five code paths advance it (create, schema PATCH, regenerate,
 * generate-again, restore) while only a completed generation writes artifacts,
 * three of those paths pointed the live URL at a version that had none:
 *
 *   - a schema `PATCH` — 404s the API, with no job queued and no recovery
 *   - `POST /versions/:v/restore` — writes no artifacts at all, so restoring a
 *     snapshot took the user's own API down
 *   - a partial `regenerate` omitting `hosted_api` — 404s permanently
 *
 * The invariant is therefore not about editing:
 *
 * > **The runtime must only ever resolve a version whose artifact set is
 * > complete.** Until publishing succeeds, the existing runtime is untouched.
 *
 * ## Why one function rather than `project.publishedVersion` at each call site
 *
 * The fallback is load-bearing and easy to forget. A reader that used the raw
 * field would resolve `undefined` for every project written before the split —
 * i.e. every project that exists — and 404 the entire platform. Routing the read
 * through here means the fallback cannot be omitted by accident, and there is one
 * place to change if it ever needs to become a query.
 */

/** The minimum a caller has to hold. Keeps this usable on a lean projection. */
export interface VersionedProject {
  currentVersion: number;
  publishedVersion?: number | null;
}

/**
 * The version whose artifacts the runtime should serve.
 *
 * Falls back to `currentVersion` when the project predates the split, which
 * reproduces the old behaviour byte for byte: a healthy project keeps serving
 * what it served, and one already skewed by the old bug stays skewed until its
 * next generation heals it. **No backfill can invent artifacts that were never
 * generated**, so pretending otherwise would only move the 404 somewhere less
 * obvious.
 */
export function publishedVersionOf(project: VersionedProject): number {
  return project.publishedVersion ?? project.currentVersion;
}

/**
 * Whether the definition has moved ahead of what is being served.
 *
 * The "pending regeneration" signal the platform had no way to express. Phase 1's
 * impact analysis reports *what* would change; this reports *that* something
 * would.
 */
export function hasPendingRegeneration(project: VersionedProject): boolean {
  return project.currentVersion > publishedVersionOf(project);
}

/**
 * Capture what is currently being served, before advancing the definition.
 *
 * Call this **immediately before** any `currentVersion += 1` on a path that does
 * not itself generate artifacts — a schema PATCH, a restore, a regenerate.
 *
 * ## Why the fallback alone is not enough
 *
 * `publishedVersionOf` falls back to `currentVersion`, which is what lets every
 * pre-split project keep serving. But a fallback *follows* the field it falls
 * back to: bump `currentVersion` on a project that has never had
 * `publishedVersion` stamped, and the fallback moves with it — straight back to
 * resolving a version with no artifacts.
 *
 * At the instant before the bump, `currentVersion` **is** the version being
 * served. Pinning it here freezes that answer, so the very first edit on a
 * legacy project protects it. Without this, protection would only begin after a
 * project's next successful generation, leaving every existing project exposed to
 * exactly the bug this work removes.
 *
 * Idempotent: it only writes when the field is absent, so it is safe on every
 * path and safe to call twice.
 */
export function pinPublishedVersion(project: VersionedProject): void {
  project.publishedVersion ??= project.currentVersion;
}

/**
 * Whether a generation must advance the version before it writes.
 *
 * ## The outage this closes
 *
 * `createOrResetArtifactRecord` sets an artifact row to
 * `status: 'pending', storageRef: null` before the work starts. The hosted
 * runtime requires `completed` with a `storageRef`, so resetting a row the
 * runtime is currently resolving 404s the live URL for the entire duration of
 * the job. A full `generate` did exactly that — it wrote into
 * `project.currentVersion`, which was also the version being served — so **every
 * ordinary regenerate took the API down while it ran**, with no editing involved.
 *
 *     v2 = LIVE  ──────────────── keeps serving throughout
 *     v3 = GENERATING  ─── schema, validation, mock data, hosted_api…
 *     v3 = LIVE  ───────────────── promoted only once hosted_api completed
 *
 * ## Why a predicate and not a computed target version
 *
 * `regenerate` and `generate-again` already advance unconditionally, and that is
 * load-bearing for reasons unrelated to this outage: the version snapshot is a
 * `$setOnInsert`, so a fresh version is what makes the note stamp land, and it is
 * what stops two rapid identical calls deduping into one job. Replacing their
 * rule with a computed target quietly removed both. Only full `generate` lacked
 * a bump, so only full `generate` needs this.
 *
 * Returns false when nothing has ever been published — a brand-new project must
 * generate *into* v1, or v1 becomes a phantom that never had artifacts and never
 * will.
 */
export function mustAdvanceBeforeGenerating(project: VersionedProject): boolean {
  if (project.publishedVersion === undefined || project.publishedVersion === null) {
    return false;
  }
  return project.currentVersion === project.publishedVersion;
}
/**
 * Whether writing artifacts at `version` would disturb the live runtime.
 *
 * A guard for the one operation that mutates an existing artifact row in place.
 * The routes should make this impossible — regenerate always advances, and full
 * generate advances when the current version is live — so a true here means a
 * caller bypassed both, which is worth failing loudly for rather than serving a
 * 404 nobody can explain.
 */
export function wouldDisturbLiveRuntime(project: VersionedProject, version: number): boolean {
  if (project.publishedVersion === undefined || project.publishedVersion === null) {
    return false;
  }
  return version === project.publishedVersion;
}

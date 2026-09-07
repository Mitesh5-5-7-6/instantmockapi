/**
 * Publishing a version — what it writes, and how to tell whether anything is live.
 *
 * ## The distinction this file exists to draw
 *
 * `hosted.url` is `{base}/{publicId}/{slug}`. There is **no version in it**, so
 * it is not a per-version artifact — it *is* the pointer. Two different things
 * were conflated in the worker's promote branch, and they belong on different
 * axes:
 *
 * | | is a property of | belongs at |
 * | --- | --- | --- |
 * | `publicId`, `slug` | the **project** — idempotent, versionless | generation |
 * | `hosted.url`, `hosted.expiresAt`, `status: 'active'` | a **live deployment existing at all** | publish |
 *
 * So a READY-but-unpublished version has an address and no URL, which is
 * correct: minting the URL at generation would advertise a link that 404s for
 * every project nobody publishes.
 *
 * ## Why `publishFields` returns data instead of mutating
 *
 * Two callers with different needs. The worker holds a loaded document and wants
 * `project.set(...)`; the publish route needs a **conditional**
 * `findOneAndUpdate` so two tabs publishing different versions cannot interleave
 * into a pointer neither of them validated. Returning a `$set`-shaped object
 * serves both, and neither has to restate which four fields a publish touches.
 */

import { calculateExpiresAt } from '@instantmockapi/config';
import { hostedUrl, type PlanTier } from '@instantmockapi/shared';
import type { IProject } from './models/project.js';

/** Everything a publish writes. Dotted keys so it drops straight into `$set`. */
export interface PublishFields {
  publishedVersion: number;
  status: 'active';
  'hosted.url': string;
  'hosted.expiresAt': Date;
}

/**
 * Whether any version is currently being served.
 *
 * **Reads `hosted.url`, not `publishedVersion`** — and that is the whole point
 * of this function existing rather than being an inline comparison.
 *
 * `pinPublishedVersion` stamps `publishedVersion` *speculatively* on the first
 * edit of a project that has never published anything, so a non-null
 * `publishedVersion` can point at a version with no artifacts that has never
 * answered a request. Reachable through ordinary routes:
 *
 *     new project                      publishedVersion: null, currentVersion: 1
 *     POST /regenerate {openapi}   →   pin sets publishedVersion = 1, current → 2
 *                                      (v1 has NO artifacts; nothing was ever live)
 *
 * Keying "is anything live" on `publishedVersion != null` would therefore
 * withhold the first-publish exception from exactly the user it exists for.
 * `hosted.url` has three writers — publish, the slug rename (guarded by
 * `if (project.hosted.url)`, so it only ever *rewrites* a non-null value) and
 * expiry, which nulls it — so it is true if and only if a version has been
 * published and not expired.
 */
export function hasLiveDeployment(project: Pick<IProject, 'hosted'>): boolean {
  return project.hosted?.url != null;
}

/**
 * The pointer move, as a `$set` payload.
 *
 * Does no I/O and does not save. `ensurePublicIdentity` must have run first,
 * because the URL reads `publicId` and `slug`; the caller owns the write.
 *
 * `expiresAt` is always recomputed, which is deliberate: it measures the life of
 * the hosted *deployment*, and publishing is the deployment. The tempting
 * `expiresAt ?? calculateExpiresAt(plan)` — start the clock only on the first
 * publish — is a regression, because the API would then die two days after that
 * first publish however actively the user was iterating. The one case that must
 * NOT come through here is re-publishing the already-live version, or Publish
 * becomes a free renewal button; the route returns early instead.
 */
export function publishFields(
  project: Pick<IProject, '_id' | 'publicId' | 'slug'>,
  version: number,
  opts: { baseUrl: string; plan: PlanTier },
): PublishFields {
  return {
    publishedVersion: version,
    // Only a publish can make a project 'active', because 'active' is what the
    // mock runtime reads as "there is something to serve".
    status: 'active',
    'hosted.url': hostedUrl(opts.baseUrl, {
      projectId: String(project._id),
      ...(project.publicId ? { publicId: project.publicId } : {}),
      ...(project.slug ? { slug: project.slug } : {}),
    }),
    'hosted.expiresAt': calculateExpiresAt(opts.plan),
  };
}

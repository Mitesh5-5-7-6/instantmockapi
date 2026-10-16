/**
 * One-off: give hosted APIs published under the old plan lifetimes the current one.
 *
 * `publishFields` stamps `hosted.expiresAt` at publish time, so removing plans
 * changes the lifetime only for the next publish. This brings every live API up
 * to "last publish + `LIMITS.hostedApiLifetimeDays`" now.
 *
 * - Only `active` projects. An expired project's mock data is already deleted,
 *   so it must be published again rather than revived here.
 * - Never shortens: an expiry already later than the new one is kept.
 * - Safe to re-run: a second run finds nothing left to extend.
 *
 * The publish time comes from the published version's `publishedAt`. Rows from
 * before that field existed fall back to `expiresAt` minus the old free
 * lifetime of two days, which was the default for nearly every account.
 */

import { LIMITS } from '@instantmockapi/config';
import { Project } from './models/project.js';
import { Version } from './models/version.js';

const DAY_MS = 86_400_000;
const OLD_DEFAULT_LIFETIME_DAYS = 2;

export interface ExtendHostedExpiryResult {
  checked: number;
  extended: number;
}

export async function extendHostedExpiry(
  now: Date = new Date(),
): Promise<ExtendHostedExpiryResult> {
  const projects = await Project.find({
    status: 'active',
    'hosted.expiresAt': { $gt: now },
  }).select('_id currentVersion publishedVersion hosted.expiresAt');

  let extended = 0;
  for (const project of projects) {
    const current = project.hosted.expiresAt as Date;
    const version = await Version.findOne({
      projectId: project._id,
      version: project.publishedVersion ?? project.currentVersion,
    }).select('publishedAt');
    const publishedAt =
      version?.publishedAt ?? new Date(current.getTime() - OLD_DEFAULT_LIFETIME_DAYS * DAY_MS);
    const target = new Date(publishedAt.getTime() + LIMITS.hostedApiLifetimeDays * DAY_MS);
    if (target.getTime() <= current.getTime()) {
      continue;
    }
    // Conditional on the value just read, so a publish landing mid-run wins.
    const written = await Project.updateOne(
      { _id: project._id, 'hosted.expiresAt': current },
      { $set: { 'hosted.expiresAt': target } },
    );
    extended += written.modifiedCount;
  }
  return { checked: projects.length, extended };
}

/**
 * The activity feed's merge step.
 *
 * Pure on purpose: the sources are three separate indexed queries, and the only
 * interesting logic — that taking N from each and then the global top N is
 * correct, and that ties break deterministically — is testable with no database.
 *
 * **No actor field.** Every source is reached through project ids that came from
 * `Project.find({ownerId: <token subject>})`, so every event here is by
 * definition the caller's own and renders as "You". The moment a project can
 * have more than one actor — teams, API keys, service accounts — that becomes a
 * lie and an explicit `actorId` is required.
 */

export type ActivityType =
  'project.created' | 'project.imported' | 'project.built' | 'version.generated' | 'job.failed';

export interface ActivityEvent {
  /** Stable id, used as the React key and as the tie-break. */
  id: string;
  type: ActivityType;
  at: string;
  projectId: string;
  projectName: string;
  text: string;
}

/**
 * Merge several already-sorted-descending source lists into one feed.
 *
 * Taking `limit` from each source and then the global top `limit` can never omit
 * a qualifying event: for an event to be wrongly dropped it would have to be
 * outranked by `limit` events *from its own source*, and in that case it was
 * never in the global top `limit` to begin with.
 *
 * Ties break on `id`, descending. Without that, two events written in the same
 * millisecond swap places between renders and the feed appears to shuffle on its
 * own.
 */
export function mergeActivity(
  sources: readonly (readonly ActivityEvent[])[],
  limit: number,
): ActivityEvent[] {
  return sources
    .flat()
    .sort((a, b) => {
      if (a.at !== b.at) {
        return a.at < b.at ? 1 : -1;
      }
      return a.id < b.id ? 1 : -1;
    })
    .slice(0, Math.max(0, limit));
}

/**
 * How a project came into being, in the author's terms.
 *
 * There is no separate "imported" event to draw on — `inputSource.type` records
 * the current value, not a history, and re-importing leaves no trace. So one
 * creation event is emitted and the verb comes from how it was created, which is
 * true and needs no new writes.
 */
export function projectCreatedEvent(project: {
  id: string;
  name: string;
  createdAt: Date;
  inputType: string;
}): ActivityEvent {
  const { type, text } =
    project.inputType === 'swagger'
      ? { type: 'project.imported' as const, text: `Imported an OpenAPI spec into ${project.name}` }
      : project.inputType === 'builder'
        ? { type: 'project.built' as const, text: `Built ${project.name} in the schema builder` }
        : { type: 'project.created' as const, text: `Created ${project.name} from a JSON sample` };

  return {
    id: `project:${project.id}`,
    type,
    at: project.createdAt.toISOString(),
    projectId: project.id,
    projectName: project.name,
    text,
  };
}

/**
 * A generation, described by the note the version already carries.
 *
 * `Version.note` is written for exactly this purpose — "Full generation",
 * "Regenerated: zod, openapi", "Generated again after expiry" — so the feed
 * quotes it rather than reconstructing what happened. The alternative, diffing
 * two `ipsSnapshot` blobs to say "added GET /products", is unreliable: a PATCH
 * bumps `currentVersion` *without* writing a Version row, so consecutive
 * snapshots can be several edits apart and the diff misattributes all of them to
 * one generation.
 */
export function versionEvent(version: {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  note: string | null;
  createdAt: Date;
}): ActivityEvent {
  const what = version.note?.trim() ? version.note.trim() : 'Generated';
  return {
    id: `version:${version.id}`,
    type: 'version.generated',
    at: version.createdAt.toISOString(),
    projectId: version.projectId,
    projectName: version.projectName,
    text: `${what} in ${version.projectName} (v${version.version})`,
  };
}

/** A generation that finished with some artifacts failed. */
export function failedJobEvent(job: {
  id: string;
  projectId: string;
  projectName: string;
  failed: number;
  total: number;
  at: Date;
}): ActivityEvent {
  return {
    id: `job:${job.id}`,
    type: 'job.failed',
    at: job.at.toISOString(),
    projectId: job.projectId,
    projectName: job.projectName,
    text: `${job.failed} of ${job.total} artifacts failed for ${job.projectName}`,
  };
}

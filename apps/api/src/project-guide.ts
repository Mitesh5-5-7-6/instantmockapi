/**
 * The AI-written guide on the Docs tab: find the stored one, or start it.
 *
 * Keyed by a hash of the project's AI Context, rendered **without** the hosted
 * URL. That document is deterministic, so an unchanged definition always finds
 * its stored guide and the model is never called on a visit. Leaving the URL
 * out keeps publishing (which only changes the URL) from forcing a rewrite.
 */

import { createHash } from 'node:crypto';
import { AppError, getErrorMessage, logger } from '@instantmockapi/shared';
import { Project, ProjectGuide, type IProject, type IProjectGuide } from '@instantmockapi/db';
import { enqueueAiGuideJob } from '@instantmockapi/queue';
import { buildDocumentationModel, renderAiContext } from '@instantmockapi/generator-docs';
import { resolveDefinition, type ResolvedDefinition } from './project-definition.js';

/** A run cannot legitimately take this long; past it, the job was lost. */
export const GUIDE_STUCK_AFTER_MS = 10 * 60_000;

interface GuideSource {
  context: string;
  contextHash: string;
  endpoints: { method: string; path: string }[];
}

export function guideSource(project: IProject, resolved: ResolvedDefinition): GuideSource {
  const model = buildDocumentationModel(resolved.ips, {
    name: project.name,
    description: project.description ?? null,
    runtime: resolved.runtime,
  });
  const context = renderAiContext(model, {});
  return {
    context,
    contextHash: createHash('sha256').update(context).digest('hex'),
    endpoints: model.endpoints.map(({ method, path }) => ({ method, path })),
  };
}

async function enqueueOrFail(guide: IProjectGuide): Promise<IProjectGuide> {
  try {
    await enqueueAiGuideJob(String(guide._id), guide.runs);
    return guide;
  } catch (cause) {
    logger.error('Could not enqueue AI guide job', {
      guideId: String(guide._id),
      error: getErrorMessage(cause),
    });
    return (
      (await ProjectGuide.findOneAndUpdate(
        { _id: guide._id, status: 'generating', runs: guide.runs },
        {
          $set: {
            status: 'failed',
            error: {
              code: 'AI_GENERATION_FAILED',
              message: 'Could not start writing the guide. Please retry.',
            },
          },
        },
        { new: true },
      )) ?? guide
    );
  }
}

/** Lazy expiry: settle a lost run on read instead of running a sweeper. */
async function expireIfStuck(guide: IProjectGuide): Promise<IProjectGuide> {
  if (
    guide.status !== 'generating' ||
    guide.requestedAt.getTime() > Date.now() - GUIDE_STUCK_AFTER_MS
  ) {
    return guide;
  }
  return (
    (await ProjectGuide.findOneAndUpdate(
      { _id: guide._id, status: 'generating', runs: guide.runs },
      {
        $set: {
          status: 'failed',
          error: { code: 'AI_GENERATION_FAILED', message: 'Writing the guide timed out. Retry.' },
        },
      },
      { new: true },
    )) ?? guide
  );
}

/** The stored guide for this definition, starting it when there is none. */
export async function ensureGuide(
  project: IProject,
  resolved: ResolvedDefinition,
): Promise<IProjectGuide> {
  const source = guideSource(project, resolved);
  const existing = await ProjectGuide.findOne({
    projectId: project._id,
    contextHash: source.contextHash,
  });
  if (existing) {
    return expireIfStuck(existing);
  }
  try {
    const created = await ProjectGuide.create({
      projectId: project._id,
      ...source,
      version: resolved.version,
    });
    return enqueueOrFail(created);
  } catch (error) {
    // Two first visits raced; the unique index let one insert. Read the winner.
    if ((error as { code?: number }).code === 11000) {
      const winner = await ProjectGuide.findOne({
        projectId: project._id,
        contextHash: source.contextHash,
      });
      if (winner) return winner;
    }
    throw error;
  }
}

/** Write the guide again, e.g. after a failure. Refused while a run is in progress. */
export async function regenerateGuide(
  project: IProject,
  resolved: ResolvedDefinition,
): Promise<IProjectGuide> {
  const current = await ensureGuide(project, resolved);
  if (current.status === 'generating') {
    throw new AppError({
      code: 'CONFLICT',
      message: 'The guide is already being written.',
    });
  }
  const restarted = await ProjectGuide.findOneAndUpdate(
    { _id: current._id, status: current.status, runs: current.runs },
    {
      $set: { status: 'generating', error: null, requestedAt: new Date() },
      $inc: { runs: 1 },
    },
    { new: true },
  );
  if (!restarted) {
    throw new AppError({ code: 'CONFLICT', message: 'The guide changed meanwhile. Reload.' });
  }
  return enqueueOrFail(restarted);
}

export function toGuideView(guide: IProjectGuide) {
  return {
    status: guide.status,
    markdown: guide.status === 'ready' ? guide.markdown : null,
    error: guide.error,
    version: guide.version,
    updatedAt: guide.updatedAt.toISOString(),
  };
}

/**
 * Start the guide for a project's current definition, after a commit changed
 * it. Fire-and-forget: a commit must never wait for, or fail because of, the
 * guide. A failure here only means the guide starts on the next visit instead.
 */
export function startGuideInBackground(projectId: string): void {
  void (async () => {
    const project = await Project.findById(projectId);
    if (!project) return;
    await ensureGuide(project, await resolveDefinition(project, { kind: 'current' }));
  })().catch((cause: unknown) => {
    logger.warn('Could not start the AI guide after a commit', {
      projectId,
      error: getErrorMessage(cause),
    });
  });
}

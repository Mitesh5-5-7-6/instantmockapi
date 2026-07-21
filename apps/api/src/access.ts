/**
 * Resource loading with ownership enforcement (doc 13 §2).
 *
 * Missing resources, malformed ids, and cross-tenant access all throw the
 * same NOT_FOUND AppError so responses never leak whether a resource exists.
 */

import { AppError, unwrap } from '@instantmockapi/shared';
import { assertOwnership } from '@instantmockapi/auth';
import { Job, Project, type IJob, type IProject } from '@instantmockapi/db';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export function notFound(resource: string): AppError {
  return new AppError({ code: 'NOT_FOUND', message: `${resource} not found` });
}

export function isObjectIdHex(id: string): boolean {
  return OBJECT_ID_PATTERN.test(id);
}

/** Load a project the token subject owns, or throw NOT_FOUND. */
export async function loadOwnedProject(projectId: string, tokenSub: string): Promise<IProject> {
  if (!isObjectIdHex(projectId)) {
    throw notFound('Project');
  }
  const project = await Project.findById(projectId);
  if (!project) {
    throw notFound('Project');
  }
  const owned = assertOwnership(project.ownerId, tokenSub, 'Project');
  unwrap(owned);
  return project;
}

/** Load a job whose parent project the token subject owns, or throw NOT_FOUND. */
export async function loadOwnedJob(
  jobId: string,
  tokenSub: string,
): Promise<{ job: IJob; project: IProject }> {
  if (!isObjectIdHex(jobId)) {
    throw notFound('Job');
  }
  const job = await Job.findById(jobId);
  if (!job) {
    throw notFound('Job');
  }
  const project = await Project.findById(job.projectId);
  if (!project) {
    throw notFound('Job');
  }
  const owned = assertOwnership(project.ownerId, tokenSub, 'Job');
  unwrap(owned);
  return { job, project };
}

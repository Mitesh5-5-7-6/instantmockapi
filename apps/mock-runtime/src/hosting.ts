/**
 * Hosted-project resolution (doc 08 §9, doc 13 §4).
 *
 * Per request: verify the project is live (active + unexpired — anything else
 * 404s so stale URLs stop resolving), then load Worker F's hosting config
 * from object storage through the cache. Tenant isolation is structural:
 * everything downstream is keyed by the projectId that resolved here.
 */

import { AppError } from '@instantmockapi/shared';
import { Project } from '@instantmockapi/db';
import { getArtifactRecord } from '@instantmockapi/registry';
import type { StorageClient } from '@instantmockapi/storage';
import type { HostedEntityConfig, HostingConfig } from '@instantmockapi/generator-hosting';
import type { CacheClient } from './cache.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const CONFIG_TTL_SECONDS = 60;

export interface HostedContext {
  projectId: string;
  version: number;
  entities: Map<string, HostedEntityConfig>;
}

export function notFound(message = 'Not found'): AppError {
  return new AppError({ code: 'NOT_FOUND', message });
}

export async function resolveHostedProject(
  projectId: string,
  deps: { storage: StorageClient; cache: CacheClient },
): Promise<HostedContext> {
  if (!OBJECT_ID_PATTERN.test(projectId)) {
    throw notFound();
  }

  const project = await Project.findById(projectId).select('status hosted currentVersion');
  if (!project || project.status !== 'active') {
    throw notFound();
  }
  // Post-expiry the URL stops resolving even before cleanup runs (doc 07 §6)
  if (project.hosted.expiresAt && project.hosted.expiresAt.getTime() <= Date.now()) {
    throw notFound();
  }

  const record = await getArtifactRecord(projectId, 'hosted_api', project.currentVersion);
  if (
    !record.ok ||
    !record.value ||
    record.value.status !== 'completed' ||
    !record.value.storageRef
  ) {
    throw notFound();
  }

  // Cache key carries version + generation time, so regeneration (same
  // version, fresh generatedAt) naturally invalidates (doc: Redis caching)
  const stamp = record.value.generatedAt ? record.value.generatedAt.getTime() : 0;
  const cacheKey = `mockcfg:${projectId}:v${project.currentVersion}:${stamp}`;

  let raw = await deps.cache.get(cacheKey);
  if (!raw) {
    const object = await deps.storage.get(record.value.storageRef);
    if (!object) {
      throw notFound();
    }
    raw = new TextDecoder().decode(object.body);
    await deps.cache.set(cacheKey, raw, CONFIG_TTL_SECONDS);
  }

  let config: HostingConfig;
  try {
    config = JSON.parse(raw) as HostingConfig;
  } catch {
    throw new AppError({ code: 'INTERNAL_ERROR', message: 'Hosted config is unreadable' });
  }

  const entities = new Map<string, HostedEntityConfig>();
  for (const entity of config.entities ?? []) {
    entities.set(entity.path, entity);
  }
  return { projectId, version: config.version, entities };
}

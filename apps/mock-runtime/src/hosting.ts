/**
 * Hosted-project resolution (doc 08 §9, doc 13 §4).
 *
 * Per request: verify the project is live (active + unexpired — anything else
 * 404s so stale URLs stop resolving), then load Worker F's hosting config
 * from object storage through the cache. Tenant isolation is structural:
 * everything downstream is keyed by the projectId that resolved here.
 */

import { AppError } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { Project } from '@instantmockapi/db';
import { getArtifactRecord } from '@instantmockapi/registry';
import type { StorageClient } from '@instantmockapi/storage';
import type { HostedEntityConfig, HostingConfig } from '@instantmockapi/generator-hosting';
import type { CacheService } from './cache.js';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export interface HostedContext {
  projectId: string;
  version: number;
  entities: Map<string, HostedEntityConfig>;
  /**
   * Generation stamp of the hosted artifact backing this context. Downstream
   * cache keys embed it so a regenerate invalidates by producing new keys
   * rather than by issuing DELs.
   */
  stamp: string;
}

export function notFound(message = 'Not found'): AppError {
  return new AppError({ code: 'NOT_FOUND', message });
}

export async function resolveHostedProject(
  projectId: string,
  deps: { storage: StorageClient; cache: CacheService; config?: EnvConfig },
): Promise<HostedContext> {
  if (!OBJECT_ID_PATTERN.test(projectId)) {
    throw notFound();
  }
  const env = deps.config ?? loadEnvConfig();

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
  // version, fresh generatedAt) naturally invalidates (doc: Redis caching).
  // Because the key is content-addressed this way, a stale hit is structurally
  // impossible — which is what lets the TTL be an hour rather than a minute.
  const stamp = String(record.value.generatedAt ? record.value.generatedAt.getTime() : 0);
  const cacheKey = `mockcfg:${projectId}:v${project.currentVersion}:${stamp}`;
  const storageRef = record.value.storageRef;

  // One read-through call: L1 hit costs zero Redis commands, L1 miss costs a
  // single GET, and concurrent misses on the same key share one object-storage
  // fetch instead of each issuing their own.
  const config = await deps.cache.read<HostingConfig>(
    cacheKey,
    {
      ttlSeconds: env.cacheConfigTtlSeconds,
      // The key is content-addressed, so the value behind it can never change:
      // a regenerate yields a different key rather than a different value.
      // L1 therefore needs no staleness cap and holds it for the full TTL —
      // this is what takes hosted-config reads off Redis almost entirely.
      l1TtlSeconds: env.cacheConfigTtlSeconds,
    },
    async () => {
      const object = await deps.storage.get(storageRef);
      if (!object) {
        throw notFound();
      }
      const raw = new TextDecoder().decode(object.body);
      try {
        return JSON.parse(raw) as HostingConfig;
      } catch {
        throw new AppError({ code: 'INTERNAL_ERROR', message: 'Hosted config is unreadable' });
      }
    },
  );

  const entities = new Map<string, HostedEntityConfig>();
  for (const entity of config.entities ?? []) {
    entities.set(entity.path, entity);
  }
  return { projectId, version: config.version, entities, stamp };
}

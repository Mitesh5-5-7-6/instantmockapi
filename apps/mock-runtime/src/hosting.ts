/**
 * Hosted-project resolution (doc 08 §9, doc 13 §4).
 *
 * Per request: verify the project is live (active + unexpired — anything else
 * 404s so stale URLs stop resolving), then load Worker F's hosting config
 * from object storage through the cache. Tenant isolation is structural:
 * everything downstream is keyed by the projectId that resolved here.
 */

import { AppError, type ProjectKind } from '@instantmockapi/shared';
import { resolveQueryFeatures, type QueryFeatures } from '@instantmockapi/ips';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { Project, publishedVersionOf } from '@instantmockapi/db';
import { getArtifactRecord } from '@instantmockapi/registry';
import type { StorageClient } from '@instantmockapi/storage';
import type { HostedEntityConfig, HostingConfig } from '@instantmockapi/generator-hosting';
import type { CacheService } from './cache.js';
import { rememberPublicId } from './identity.js';
import type { HostedRefInput } from './path.js';

export interface HostedContext {
  /**
   * Canonical Mongo id. Every downstream cache key is built from THIS, never from
   * the public id — which is what lets the legacy and pretty URL forms share
   * every cache entry without a form discriminator in the key.
   */
  projectId: string;
  version: number;
  kind: ProjectKind;
  publicId: string | null;
  slug: string | null;
  entities: Map<string, HostedEntityConfig>;
  /**
   * Query capabilities this project has switched on. Resolved from the hosted
   * config, so a config generated before the query layer reads as all-off and
   * the API it backs answers exactly as it did before.
   */
  features: QueryFeatures;
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

// `publishedVersion` is in the projection because the runtime resolves on it;
// `currentVersion` stays only as its pre-split fallback. Dropping either from
// the projection makes `publishedVersionOf` resolve undefined and 404 the
// project — a lean projection is exactly how that mistake gets made.
const PROJECT_FIELDS = 'status hosted currentVersion publishedVersion kind publicId slug';

export async function resolveHostedProject(
  ref: HostedRefInput,
  deps: { storage: StorageClient; cache: CacheService; config?: EnvConfig },
): Promise<HostedContext> {
  const env = deps.config ?? loadEnvConfig();

  // Both lookups cost one indexed query. The slug segment is deliberately NOT
  // part of the pretty filter: a stale slug still resolves, so renaming one can
  // never break a URL someone has already copied.
  const project =
    ref.form === 'legacy'
      ? await Project.findById(ref.projectId).select(PROJECT_FIELDS)
      : await Project.findOne({ publicId: ref.publicId }).select(PROJECT_FIELDS);

  if (!project || project.status !== 'active') {
    throw notFound();
  }
  const projectId = String(project._id);
  // Post-expiry the URL stops resolving even before cleanup runs (doc 07 §6)
  if (project.hosted.expiresAt && project.hosted.expiresAt.getTime() <= Date.now()) {
    throw notFound();
  }

  // THE deployment boundary. Resolving on `currentVersion` is what coupled
  // editing to deployment: a schema PATCH or a restore advances that field
  // without writing any artifacts, so the live URL pointed at a version that
  // did not exist. `publishedVersion` only ever advances when a generation
  // actually wrote a hosted_api artifact.
  const version = publishedVersionOf(project);
  const record = await getArtifactRecord(projectId, 'hosted_api', version);
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
  const cacheKey = `mockcfg:${projectId}:v${version}:${stamp}`;
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

  // Lets the rate limiter canonicalise a pretty-URL key without any I/O.
  rememberPublicId(project.publicId, projectId);

  return {
    projectId,
    version: config.version,
    kind: project.kind ?? 'project',
    publicId: project.publicId ?? null,
    slug: project.slug ?? null,
    entities,
    features: resolveQueryFeatures(config.features),
    stamp,
  };
}

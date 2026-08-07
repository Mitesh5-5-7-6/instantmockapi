/**
 * Mock record store access (doc 07 `mockStores`, doc 13 §4).
 *
 * Records live per (projectId, entity) — namespacing IS the tenant isolation.
 * Reads go through the tiered cache; every write persists to Mongo and
 * invalidates the cached copy so subsequent reads are consistent.
 *
 * The cache key embeds the hosted artifact's generation stamp. That matters
 * because `apps/workers` re-seeds `mockStores` directly during generation,
 * outside this module's invalidation path — previously the only thing bounding
 * that staleness was a 10s TTL, which forced a Redis GET on nearly every
 * request. Keying by stamp makes a post-regenerate read miss by construction,
 * so the TTL no longer has to carry that job.
 */

import { MockStore } from '@instantmockapi/db';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { CacheService } from './cache.js';

export type MockRecord = Record<string, unknown>;

/** Identifies which generation of a project's data a key belongs to. */
export interface SeedScope {
  projectId: string;
  stamp: string;
}

function cacheKey(scope: SeedScope, entity: string): string {
  return `mockseed:${scope.projectId}:${scope.stamp}:${entity}`;
}

export async function readRecords(
  scope: SeedScope,
  entity: string,
  cache: CacheService,
  config: EnvConfig = loadEnvConfig(),
): Promise<MockRecord[]> {
  return cache.read<MockRecord[]>(
    cacheKey(scope, entity),
    {
      ttlSeconds: config.cacheSeedTtlSeconds,
      // Records are mutable, so L1 gets a short lease: it bounds how long a
      // second runtime replica could serve a value this one has since
      // rewritten. Single-replica deployments are unaffected either way.
      l1TtlSeconds: config.cacheSeedL1TtlSeconds,
    },
    async () => {
      const store = await MockStore.findOne({ projectId: scope.projectId, entity });
      return (store?.records ?? []) as MockRecord[];
    },
  );
}

export async function writeRecords(
  scope: SeedScope,
  entity: string,
  records: MockRecord[],
  cache: CacheService,
  config: EnvConfig = loadEnvConfig(),
): Promise<void> {
  await MockStore.findOneAndUpdate(
    { projectId: scope.projectId, entity },
    { $set: { records } },
    { upsert: true },
  );
  // Write-through rather than delete-then-reload: the next reader would have
  // re-fetched from Mongo and issued a SET anyway, so seeding the new value
  // here costs the same one Redis command and saves that reader a round-trip.
  await cache.setJSON(cacheKey(scope, entity), records, {
    ttlSeconds: config.cacheSeedTtlSeconds,
    l1TtlSeconds: config.cacheSeedL1TtlSeconds,
  });
}

/** Stable record identity: the `id` field. Seeded records lacking one get `rec-<n>`. */
export function recordId(record: MockRecord, index: number): string {
  const value = record['id'];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return `rec-${index + 1}`;
}

export function findRecordIndex(records: MockRecord[], id: string): number {
  return records.findIndex((record, index) => recordId(record, index) === id);
}

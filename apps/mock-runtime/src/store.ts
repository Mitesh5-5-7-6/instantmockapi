/**
 * Mock record store access (doc 07 `mockStores`, doc 13 §4).
 *
 * Records live per (projectId, entity) — namespacing IS the tenant isolation.
 * Reads go through the cache with a short TTL; every write persists to Mongo
 * and invalidates the cached copy so subsequent reads are consistent.
 */

import { MockStore } from '@instantmockapi/db';
import type { CacheClient } from './cache.js';

const SEED_TTL_SECONDS = 10;

export type MockRecord = Record<string, unknown>;

function cacheKey(projectId: string, entity: string): string {
  return `mockseed:${projectId}:${entity}`;
}

export async function readRecords(
  projectId: string,
  entity: string,
  cache: CacheClient,
): Promise<MockRecord[]> {
  const key = cacheKey(projectId, entity);
  const cached = await cache.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as MockRecord[];
    } catch {
      await cache.del(key);
    }
  }
  const store = await MockStore.findOne({ projectId, entity });
  const records = (store?.records ?? []) as MockRecord[];
  await cache.set(key, JSON.stringify(records), SEED_TTL_SECONDS);
  return records;
}

export async function writeRecords(
  projectId: string,
  entity: string,
  records: MockRecord[],
  cache: CacheClient,
): Promise<void> {
  await MockStore.findOneAndUpdate({ projectId, entity }, { $set: { records } }, { upsert: true });
  await cache.del(cacheKey(projectId, entity));
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

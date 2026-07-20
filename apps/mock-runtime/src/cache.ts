/**
 * Cache abstraction for hosted config + seed reads (doc 14, Phase 7).
 * Redis in production; an in-memory implementation for tests and
 * infrastructure-free local runs. Writes invalidate via del().
 */

import Redis from 'ioredis';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export function createMemoryCache(): CacheClient & { clear(): void } {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt < Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

export function createRedisCache(config: EnvConfig = loadEnvConfig()): CacheClient {
  const redis = new Redis(config.redisUrl);
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

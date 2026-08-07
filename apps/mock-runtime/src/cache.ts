/**
 * Cache wiring for the mock runtime.
 *
 * The implementation now lives in @instantmockapi/cache so the API, workers
 * and runtime share one tiered CacheService instead of each hand-rolling
 * get/set/del against ioredis. This module stays as the runtime's local
 * factory surface.
 */

import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { CacheService, createCacheService, createMemoryCacheService } from '@instantmockapi/cache';

export type { CacheClient, CacheStats } from '@instantmockapi/cache';
export { CacheService };

/** L1-only cache: tests and infrastructure-free local runs. */
export function createMemoryCache(): CacheService {
  return createMemoryCacheService();
}

/**
 * Environment-driven cache: L1 + Redis when Redis is enabled, L1-only
 * otherwise. Replaces the previous unconditional `createRedisCache`.
 */
export function createCache(config: EnvConfig = loadEnvConfig()): CacheService {
  return createCacheService(config);
}

/**
 * @deprecated Use {@link createCache}, which honors REDIS_ENABLED and adds the
 * in-process L1 tier. Kept so existing callers keep compiling.
 */
export function createRedisCache(config: EnvConfig = loadEnvConfig()): CacheService {
  return createCacheService(config);
}

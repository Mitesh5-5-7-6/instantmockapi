// @instantmockapi/cache — centralized multi-tier cache (L1 LRU → Redis → origin).

export { LruCache, type LruEntry, type LruOptions } from './lru.js';
export {
  CacheService,
  type CacheClient,
  type CacheServiceOptions,
  type CacheStats,
  type ReadOptions,
  type RedisLike,
} from './service.js';
export {
  createCacheService,
  createMemoryCacheService,
  getCacheRedis,
  closeCacheRedis,
} from './factory.js';

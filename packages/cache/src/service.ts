/**
 * CacheService — the single entry point for cache reads/writes across the
 * platform (previously each consumer talked to ioredis directly).
 *
 * Tiering: L1 (in-process LRU) → L2 (Redis) → loader (MongoDB / object
 * storage). Every tier is optional: with Redis disabled the service degrades
 * to L1-only, which is what local development and the test suite run on.
 *
 * The design target is the free Redis Cloud plan: 500K commands/month. Every
 * public method below either avoids a Redis command or accounts for it in
 * `stats()`.
 */

import { logger } from '@instantmockapi/shared';
import { LruCache } from './lru.js';

/** The subset of ioredis the service uses. Narrow, so tests can fake it. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
}

/** Back-compat surface: the shape mock-runtime consumed before centralization. */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface ReadOptions {
  /** Redis (L2) TTL. */
  ttlSeconds: number;
  /**
   * L1 TTL. Caps how long this process may serve a value without consulting
   * Redis — i.e. the worst-case staleness window when another replica writes.
   * Defaults to the service-wide L1 cap. Set it low for mutable data.
   */
  l1TtlSeconds?: number;
}

export interface CacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  /** Concurrent misses on the same key served by one in-flight load. */
  coalesced: number;
  /** Redis SETs skipped because the stored value was already identical. */
  suppressedWrites: number;
  /** Redis round-trips actually issued by this process. */
  redisCommands: number;
  redisErrors: number;
  l1Entries: number;
  l1Bytes: number;
  redisEnabled: boolean;
}

export interface CacheServiceOptions {
  /** Null/omitted → L1-only mode (development, tests, Redis outage fallback). */
  redis?: RedisLike | null;
  l1MaxEntries?: number;
  l1MaxBytes?: number;
  /** Upper bound applied to every ReadOptions.l1TtlSeconds. */
  l1MaxTtlSeconds?: number;
}

/**
 * Fraction of a key's TTL within which an identical re-write is suppressed.
 * Past this point we do re-issue the SET so the entry never silently expires
 * out of Redis while this process still believes it is cached.
 */
const REWRITE_SUPPRESSION_WINDOW = 0.5;

export class CacheService implements CacheClient {
  private readonly l1: LruCache;
  private readonly redis: RedisLike | null;
  private readonly l1MaxTtlSeconds: number;
  /** In-flight loads keyed by cache key — collapses concurrent misses. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  private stat = {
    l1Hits: 0,
    l2Hits: 0,
    misses: 0,
    coalesced: 0,
    suppressedWrites: 0,
    redisCommands: 0,
    redisErrors: 0,
  };

  constructor(options: CacheServiceOptions = {}) {
    this.redis = options.redis ?? null;
    this.l1 = new LruCache({
      maxEntries: options.l1MaxEntries ?? 500,
      maxBytes: options.l1MaxBytes ?? 16 * 1024 * 1024,
    });
    this.l1MaxTtlSeconds = options.l1MaxTtlSeconds ?? 60;
  }

  get redisEnabled(): boolean {
    return this.redis !== null;
  }

  /**
   * Read-through across all three tiers. This is the method callers should
   * reach for: it is the only path that gets L1 hits, miss coalescing and
   * single-command L2 access.
   *
   * `loader` runs at most once per key per miss, even under concurrent load.
   */
  async read<T>(key: string, options: ReadOptions, loader: () => Promise<T>): Promise<T> {
    const hit = this.l1.get(key);
    if (hit) {
      const parsed = tryParse<T>(hit.value);
      if (parsed.ok) {
        this.stat.l1Hits++;
        return parsed.value;
      }
      this.l1.delete(key);
    }

    const existing = this.inflight.get(key);
    if (existing) {
      this.stat.coalesced++;
      return existing as Promise<T>;
    }

    const load = this.loadThrough(key, options, loader).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, load);
    return load;
  }

  private async loadThrough<T>(
    key: string,
    options: ReadOptions,
    loader: () => Promise<T>,
  ): Promise<T> {
    const raw = await this.redisGet(key);
    if (raw !== null) {
      const parsed = tryParse<T>(raw);
      if (parsed.ok) {
        this.stat.l2Hits++;
        this.rememberL1(key, raw, options, { fromRedis: true });
        return parsed.value;
      }
      // Corrupt payload: drop it rather than serving garbage (this preserves
      // the pre-refactor behavior in mock-runtime's seed store).
      logger.warn('Discarding unparseable cache entry', { key });
      await this.del(key);
    }

    this.stat.misses++;
    const value = await loader();
    const encoded = JSON.stringify(value);
    await this.writeThrough(key, encoded, options);
    return value;
  }

  /** Explicit write. Honors identical-value suppression. */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.writeThrough(key, value, { ttlSeconds });
  }

  async setJSON(key: string, value: unknown, options: ReadOptions): Promise<void> {
    await this.writeThrough(key, JSON.stringify(value), options);
  }

  private async writeThrough(key: string, value: string, options: ReadOptions): Promise<void> {
    if (this.redis) {
      const previous = this.l1.peek(key);
      const identical =
        previous?.redisValue === value &&
        previous.redisWrittenAt !== undefined &&
        previous.redisTtlSeconds !== undefined &&
        Date.now() - previous.redisWrittenAt <
          previous.redisTtlSeconds * 1000 * REWRITE_SUPPRESSION_WINDOW;

      if (identical) {
        this.stat.suppressedWrites++;
      } else {
        await this.redisCall(
          () => this.redis!.set(key, value, 'EX', options.ttlSeconds),
          'set',
          key,
        );
        this.rememberL1(key, value, options, { fromRedis: false });
        return;
      }
    }
    this.rememberL1(key, value, options, { fromRedis: false });
  }

  /**
   * Direct L2 read, no L1 and no loader. Retained so the CacheClient contract
   * still holds for callers that have not moved to read().
   */
  async get(key: string): Promise<string | null> {
    const hit = this.l1.get(key);
    if (hit) {
      this.stat.l1Hits++;
      return hit.value;
    }
    const raw = await this.redisGet(key);
    if (raw !== null) {
      this.stat.l2Hits++;
      this.rememberL1(key, raw, { ttlSeconds: this.l1MaxTtlSeconds }, { fromRedis: true });
    } else {
      this.stat.misses++;
    }
    return raw;
  }

  /**
   * Multi-key read: one Redis MGET for whatever L1 could not answer, instead
   * of one GET per key. Returns values positionally aligned with `keys`.
   */
  async mget(keys: string[]): Promise<(string | null)[]> {
    const results: (string | null)[] = new Array<string | null>(keys.length).fill(null);
    const pending: { key: string; index: number }[] = [];

    keys.forEach((key, index) => {
      const hit = this.l1.get(key);
      if (hit) {
        this.stat.l1Hits++;
        results[index] = hit.value;
      } else {
        pending.push({ key, index });
      }
    });

    if (pending.length === 0 || !this.redis) {
      this.stat.misses += pending.length;
      return results;
    }

    const fetched = await this.redisCall(
      () => this.redis!.mget(...pending.map((entry) => entry.key)),
      'mget',
      pending[0]!.key,
    );
    if (!fetched) {
      this.stat.misses += pending.length;
      return results;
    }

    pending.forEach((entry, position) => {
      const value = fetched[position] ?? null;
      results[entry.index] = value;
      if (value === null) {
        this.stat.misses++;
      } else {
        this.stat.l2Hits++;
        this.rememberL1(
          entry.key,
          value,
          { ttlSeconds: this.l1MaxTtlSeconds },
          { fromRedis: true },
        );
      }
    });
    return results;
  }

  async del(key: string): Promise<void> {
    await this.delMany([key]);
  }

  /** Variadic DEL — N keys removed in a single Redis command. */
  async delMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.l1.delete(key);
    }
    if (this.redis && keys.length > 0) {
      await this.redisCall(() => this.redis!.del(...keys), 'del', keys[0]!);
    }
  }

  stats(): CacheStats {
    return {
      ...this.stat,
      l1Entries: this.l1.size,
      l1Bytes: this.l1.bytes,
      redisEnabled: this.redisEnabled,
    };
  }

  /** Drops L1 only. Used by tests between cases. */
  clear(): void {
    this.l1.clear();
    this.inflight.clear();
  }

  async close(): Promise<void> {
    this.l1.clear();
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }

  private rememberL1(
    key: string,
    value: string,
    options: ReadOptions,
    context: { fromRedis: boolean },
  ): void {
    const ttl = Math.min(options.l1TtlSeconds ?? this.l1MaxTtlSeconds, options.ttlSeconds);
    const meta = context.fromRedis
      ? {}
      : { redisValue: value, redisWrittenAt: Date.now(), redisTtlSeconds: options.ttlSeconds };
    this.l1.set(key, value, ttl, meta);
  }

  private async redisGet(key: string): Promise<string | null> {
    if (!this.redis) {
      return null;
    }
    const value = await this.redisCall(() => this.redis!.get(key), 'get', key);
    return value ?? null;
  }

  /**
   * Every Redis round-trip funnels through here so `stats().redisCommands`
   * is an accurate month-to-date count, and so a Redis outage degrades to a
   * cache miss (served from the loader) instead of failing the request.
   */
  private async redisCall<T>(
    operation: () => Promise<T>,
    name: string,
    key: string,
  ): Promise<T | null> {
    this.stat.redisCommands++;
    try {
      return await operation();
    } catch (error) {
      this.stat.redisErrors++;
      logger.warn('Redis command failed; falling back to origin', {
        operation: name,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function tryParse<T>(raw: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false };
  }
}

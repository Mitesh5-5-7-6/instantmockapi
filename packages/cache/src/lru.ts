/**
 * Bounded in-memory LRU with per-entry TTL — the L1 tier of the CacheService.
 *
 * L1 exists to keep Redis command count off the hot path: on the free Redis
 * Cloud plan (500K commands/month) a single hosted mock served at a few
 * requests/second would otherwise spend the whole monthly budget on GETs.
 *
 * Bounded by BOTH entry count and total bytes: hosted configs and seed record
 * sets are user-sized payloads, so an entry-only bound would let a handful of
 * large projects pin an unbounded amount of heap.
 */

export interface LruEntry {
  value: string;
  expiresAt: number;
  bytes: number;
  /**
   * The value most recently written to Redis under this key, plus when and
   * with what TTL. Lets CacheService.set() skip a Redis SET that would store
   * a byte-identical value under a still-valid TTL.
   */
  redisValue?: string;
  redisWrittenAt?: number;
  redisTtlSeconds?: number;
}

export interface LruOptions {
  maxEntries: number;
  maxBytes: number;
}

export class LruCache {
  /** Insertion-ordered: the first key is always the least recently used. */
  private readonly entries = new Map<string, LruEntry>();
  private totalBytes = 0;

  constructor(private readonly options: LruOptions) {}

  /** Live entry for `key`, or undefined when absent or expired. Bumps recency. */
  get(key: string, now: number = Date.now()): LruEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    // Re-insert to move this key to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Entry lookup that does NOT bump recency and tolerates expiry. Used for
   * write-suppression bookkeeping, which must be able to read the Redis
   * metadata of an entry whose cached value has already aged out.
   */
  peek(key: string): LruEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string, ttlSeconds: number, meta: Partial<LruEntry> = {}): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(key);
    }

    const bytes = Buffer.byteLength(value, 'utf8') + Buffer.byteLength(key, 'utf8');
    const entry: LruEntry = {
      ...previous,
      ...meta,
      value,
      bytes,
      expiresAt: Date.now() + Math.max(0, ttlSeconds) * 1000,
    };

    // A single entry larger than the whole budget is never admitted — caching
    // it would evict everything else and then be evicted itself.
    if (bytes > this.options.maxBytes) {
      return;
    }

    this.entries.set(key, entry);
    this.totalBytes += bytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.totalBytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries || this.totalBytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.delete(oldest.value);
    }
  }
}

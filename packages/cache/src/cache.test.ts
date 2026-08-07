import { describe, expect, it, vi } from 'vitest';
import { CacheService, type RedisLike } from './service.js';
import { LruCache } from './lru.js';

/** Counting fake so assertions are on Redis command volume, not behavior. */
function fakeRedis(): RedisLike & { commands: string[]; store: Map<string, string> } {
  const store = new Map<string, string>();
  const commands: string[] = [];
  return {
    store,
    commands,
    async get(key) {
      commands.push(`get ${key}`);
      return store.get(key) ?? null;
    },
    async mget(...keys) {
      commands.push(`mget ${keys.join(',')}`);
      return keys.map((key) => store.get(key) ?? null);
    },
    async set(key, value) {
      commands.push(`set ${key}`);
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      commands.push(`del ${keys.join(',')}`);
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed++;
      }
      return removed;
    },
    async quit() {
      return 'OK';
    },
  };
}

describe('LruCache', () => {
  it('evicts least-recently-used entries past the entry bound', () => {
    const lru = new LruCache({ maxEntries: 2, maxBytes: 1_000_000 });
    lru.set('a', '1', 60);
    lru.set('b', '2', 60);
    lru.get('a'); // 'a' becomes most-recently-used, so 'b' is next out
    lru.set('c', '3', 60);

    expect(lru.get('a')?.value).toBe('1');
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')?.value).toBe('3');
  });

  it('evicts on the byte bound and refuses oversized entries', () => {
    const lru = new LruCache({ maxEntries: 100, maxBytes: 64 });
    lru.set('k1', 'x'.repeat(40), 60);
    lru.set('k2', 'y'.repeat(40), 60);
    expect(lru.size).toBe(1);

    lru.set('huge', 'z'.repeat(500), 60);
    expect(lru.get('huge')).toBeUndefined();
  });

  it('expires entries by TTL', () => {
    const lru = new LruCache({ maxEntries: 10, maxBytes: 1_000_000 });
    lru.set('k', 'v', 30);
    expect(lru.get('k', Date.now() + 31_000)).toBeUndefined();
  });
});

describe('CacheService read-through', () => {
  it('serves repeat reads from L1 with no further Redis commands', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis, l1MaxTtlSeconds: 60 });
    const loader = vi.fn().mockResolvedValue({ hello: 'world' });

    for (let i = 0; i < 10; i++) {
      await cache.read('k', { ttlSeconds: 300 }, loader);
    }

    expect(loader).toHaveBeenCalledTimes(1);
    // One GET (miss) + one SET. The other nine reads cost nothing.
    expect(redis.commands).toEqual(['get k', 'set k']);
    expect(cache.stats().l1Hits).toBe(9);
  });

  it('collapses concurrent misses into a single load', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis });
    const loader = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { n: 1 };
    });

    await Promise.all(Array.from({ length: 8 }, () => cache.read('k', { ttlSeconds: 60 }, loader)));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands).toEqual(['get k', 'set k']);
    expect(cache.stats().coalesced).toBe(7);
  });

  it('falls back to Redis when L1 has expired, then repopulates L1', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis, l1MaxTtlSeconds: 0 });
    const loader = vi.fn().mockResolvedValue({ v: 1 });

    await cache.read('k', { ttlSeconds: 300 }, loader);
    await cache.read('k', { ttlSeconds: 300 }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands).toEqual(['get k', 'set k', 'get k']);
    expect(cache.stats().l2Hits).toBe(1);
  });

  it('discards an unparseable Redis value and reloads from origin', async () => {
    const redis = fakeRedis();
    redis.store.set('k', '{ not json');
    const cache = new CacheService({ redis });
    const loader = vi.fn().mockResolvedValue({ ok: true });

    await expect(cache.read('k', { ttlSeconds: 60 }, loader)).resolves.toEqual({ ok: true });
    expect(redis.commands).toContain('del k');
  });

  it('serves reads from the loader when Redis is disabled', async () => {
    const cache = new CacheService({ redis: null });
    const loader = vi.fn().mockResolvedValue({ v: 2 });

    await cache.read('k', { ttlSeconds: 60 }, loader);
    await cache.read('k', { ttlSeconds: 60 }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().redisCommands).toBe(0);
    expect(cache.stats().redisEnabled).toBe(false);
  });

  it('treats a Redis failure as a miss rather than an error', async () => {
    const redis = fakeRedis();
    redis.get = async () => {
      throw new Error('connection reset');
    };
    const cache = new CacheService({ redis });

    await expect(
      cache.read('k', { ttlSeconds: 60 }, async () => ({ fromOrigin: true })),
    ).resolves.toEqual({ fromOrigin: true });
    expect(cache.stats().redisErrors).toBe(1);
  });
});

describe('CacheService writes', () => {
  it('suppresses a Redis SET that would store an identical value', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis, l1MaxTtlSeconds: 60 });

    await cache.set('k', 'same', 300);
    await cache.set('k', 'same', 300);
    await cache.set('k', 'same', 300);

    expect(redis.commands).toEqual(['set k']);
    expect(cache.stats().suppressedWrites).toBe(2);
  });

  it('still writes when the value changes', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis, l1MaxTtlSeconds: 60 });

    await cache.set('k', 'one', 300);
    await cache.set('k', 'two', 300);

    expect(redis.commands).toEqual(['set k', 'set k']);
  });

  it('deletes many keys in one command and drops them from L1', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis });

    await cache.set('a', '1', 60);
    await cache.set('b', '2', 60);
    redis.commands.length = 0;

    await cache.delMany(['a', 'b']);

    expect(redis.commands).toEqual(['del a,b']);
    expect(await cache.get('a')).toBeNull();
  });
});

describe('CacheService mget', () => {
  it('fetches only L1 misses, in a single MGET', async () => {
    const redis = fakeRedis();
    const cache = new CacheService({ redis, l1MaxTtlSeconds: 60 });

    await cache.set('a', 'A', 300);
    redis.store.set('b', 'B');
    redis.store.set('c', 'C');
    redis.commands.length = 0;

    const values = await cache.mget(['a', 'b', 'c']);

    expect(values).toEqual(['A', 'B', 'C']);
    expect(redis.commands).toEqual(['mget b,c']);
  });
});

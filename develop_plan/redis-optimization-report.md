# Redis Optimization Report

Target: Redis Cloud free plan — **500,000 commands/month**, 30MB.

## Headline finding

The cache was not the problem. **An idle BullMQ worker consumed ~605,000 commands/month
before serving a single request** — more than the entire monthly budget, at zero traffic.
Any optimization confined to the caching layer could not have brought this under plan.

Two workers were possible simultaneously (`RUN_WORKER_IN_PROCESS=true` in the API *plus*
the `apps/workers` deployment), which doubles that to ~1.21M/month.

---

## 1. Complete Redis usage audit

Every Redis touchpoint in the repository, before optimization.

### 1.1 Queue — `packages/queue/src/queue.ts`

| Site | Command(s) | Why it exists | Verdict |
|---|---|---|---|
| `createGenerationWorker` idle loop | `BZPOPMIN` every `drainDelay` (**5s** default) | BullMQ blocks waiting for a job; the timeout bounds how long the socket stays blocked | **Wasteful** — 17,280/day/worker |
| `createGenerationWorker` stalled sweep | `EVALSHA moveStalledJobsToWait` every `stalledInterval` (**30s** default) | Recovers jobs orphaned by a crashed worker | **Wasteful** — 2,880/day/worker |
| `enqueueGenerationJob` → `queue.getJob()` | `HMGET` | Detects an existing job under the idempotency key | Necessary |
| `enqueueGenerationJob` → `existing.getState()` | 1–2 lookups | Distinguishes in-flight from settled, so a failed job does not permanently block re-enqueue | Necessary |
| `enqueueGenerationJob` → `existing.remove()` | `EVALSHA` | Clears a settled job so re-enqueue works | Necessary |
| `queue.add()` | `EVALSHA` | Enqueue | Necessary |
| Job execution | lock renewal every `lockDuration/2` (15s) + lifecycle writes | Keeps the job lease alive while generating | Necessary |

### 1.2 Cache — `apps/mock-runtime/src/cache.ts` (`createRedisCache`)

A thin `get` / `set` / `del` wrapper over ioredis. Two consumers:

| Site | Command(s) per request | Why it exists | Verdict |
|---|---|---|---|
| `hosting.ts` — hosted config | 1 `GET`, plus `SET EX 60` on miss | Avoids re-reading Worker F's hosting config from object storage on every request | Necessary, but **TTL far too short** |
| `store.ts` — seed records read | 1 `GET`, plus `SET EX 10` on miss | Avoids a Mongo `findOne` per request | Necessary, but **TTL too short and no L1** |
| `store.ts` — seed records write | 1 `DEL` | Invalidates after a runtime CRUD write | Replaceable by write-through |

**Every hosted mock request cost at least 2 Redis commands, unconditionally.** Cost scaled
strictly linearly with traffic, with no ceiling.

### 1.3 Not Redis-backed (verified, no change needed)

- **Authentication** — already stateless JWT (`packages/auth/src/tokens.ts`); `POST /auth/logout`
  discards tokens client-side. **Requirement 6 was already satisfied — no session store exists.**
- **Rate limiting** — `@fastify/rate-limit` is registered in both `apps/api/src/server.ts` and
  `apps/mock-runtime/src/server.ts` with no `redis` option, so it uses its in-process store.
- **Dead code** — `getRedisConnection` is exported from `@instantmockapi/queue` but has no
  consumer outside the package and its own test mocks. Left in place (removing it would break
  the five test files that mock it); it is no longer the path cache traffic takes.

### 1.4 Correctness gap found during the audit

`apps/workers/src/processor.ts:188` writes `MockStore` directly when seeding a generation —
**outside** `store.ts`'s invalidation path. The only thing bounding that staleness was the 10s
seed TTL. That is *why* the TTL was 10s, and it meant the TTL could not simply be raised.
Fixed structurally below.

---

## 2. Optimizations applied

### 2.1 Queue polling — the dominant win

`packages/queue/src/queue.ts`

| Setting | Before | After | Env var |
|---|---|---|---|
| `drainDelay` | 5s | 60s | `QUEUE_DRAIN_DELAY_SECONDS` |
| `stalledInterval` | 30s | 300s | `QUEUE_STALLED_INTERVAL_MS` |

**Why raising `drainDelay` is free.** It is the *timeout* on an idle blocking read, not a poll
interval. `Queue.add` writes the marker key that wakes the blocked `BZPOPMIN` immediately, so
job pickup latency is unchanged — a job enqueued one second into a 60-second wait is still
picked up in that same second.

**The one trade-off.** A job orphaned by a hard worker crash is now recovered after up to
5 minutes instead of 30 seconds. This is a crash-recovery path, not the happy path; retries
and idempotency are unaffected. Tune `QUEUE_STALLED_INTERVAL_MS` down if that matters more
than command budget.

### 2.2 Centralized `CacheService` — `packages/cache` (new)

Replaces the ad-hoc ioredis wrapper. One implementation, three tiers: **L1 (in-process LRU) →
L2 (Redis) → origin loader (Mongo / object storage)**.

- **`read(key, opts, loader)`** — the single read path. L1 hit costs zero Redis commands.
- **Miss coalescing** — concurrent misses on the same key share one in-flight load, instead of
  each issuing its own `GET` + origin fetch. Directly cuts the thundering-herd multiplier.
- **Identical-write suppression** — `set()` skips a Redis `SET` when the value is byte-identical
  to what this process already wrote under a still-valid TTL (requirement 2).
- **`mget`** — batches whatever L1 could not answer into one `MGET` rather than N `GET`s.
- **`delMany`** — N keys in one variadic `DEL`.
- **Bounded L1** — LRU capped by *both* entry count and total bytes, since hosted configs and
  seed sets are user-sized payloads. Oversized entries are refused rather than evicting the world.
- **Redis failure degrades, never fails** — a Redis error is logged and treated as a miss; the
  request is served from the origin loader.
- **`stats()`** — per-process counters (L1 hits, L2 hits, misses, coalesced loads, suppressed
  writes, Redis commands, Redis errors), exposed on the mock runtime's `/healthz`.

### 2.3 TTL review

| Key | TTL before | TTL after | Justification |
|---|---|---|---|
| `mockcfg:{project}:v{n}:{stamp}` | 60s | **3600s** (`CACHE_CONFIG_TTL_SECONDS`) | The key is **content-addressed** — it embeds version + `generatedAt`. A regenerate produces a *different key*, never a stale value. A short TTL bought nothing. |
| `mockcfg` L1 | n/a | **3600s** (full TTL, uncapped) | Same reason: the value behind a given key is immutable, so L1 needs no staleness cap. This is what takes config reads off Redis almost entirely. |
| `mockseed:{project}:{stamp}:{entity}` | 10s | **900s** (`CACHE_SEED_TTL_SECONDS`) | Newly safe: the key now embeds the same generation stamp, so the worker's out-of-band re-seed (§1.4) invalidates *by construction* instead of relying on the TTL. Runtime CRUD writes still invalidate explicitly. |
| `mockseed` L1 | n/a | **5s** (`CACHE_SEED_L1_TTL_SECONDS`) | Records are mutable. This bounds how long a *second replica* could serve a value this one has rewritten. Single-replica deployments can safely raise it — see §5. |

### 2.4 Invalidation removed

`writeRecords` previously did `Mongo write` → `DEL`, forcing the next reader to miss and re-issue
`GET` + Mongo read + `SET`. It is now **write-through**: the new value is written to cache
directly. Same one Redis command, and it saves the next reader a full round-trip.

### 2.5 Development mode

`REDIS_ENABLED` controls whether cache traffic touches Redis at all. Resolution order:

1. Explicit `REDIS_ENABLED=true|false` always wins.
2. Otherwise, in `development`/`test`: enabled **only if `REDIS_URL` is set**.
3. Otherwise (staging/production): enabled.

With Redis off, `CacheService` runs L1-only and every consumer works unchanged — no connection,
no commands, no code branches at the call sites. The existing `.env` sets `REDIS_URL`, so current
local behavior is preserved; delete that line to develop against the in-memory cache.

> The generation queue still requires Redis — BullMQ has no in-memory transport. Only the
> cache path is disable-able.

### 2.6 What was deliberately *not* changed

- **`removeOnFail: false`** — flagged as a bottleneck (§6) rather than changed, because keeping
  failed jobs is documented intent for debugging and manual retry. Changing retention is a
  behavior decision, not an optimization.
- **`MGET` at the hosted-request path** — no natural batch site exists. The config read must
  complete before the seed key is even known (entity resolution depends on the config), so the
  two reads are strictly sequential, not batchable. `mget` is implemented and tested on the
  service for callers that can use it; forcing it here would have been theatre.
- **Business logic** — no route, status code, validation rule, or response shape changed.

---

## 3. Before vs. after

### 3.1 Fixed cost — per worker process, traffic-independent

| Source | Before | After | Change |
|---|---:|---:|---:|
| Idle `BZPOPMIN` | 518,400/mo | 43,200/mo | −91.7% |
| Stalled sweep | 86,400/mo | 8,640/mo | −90.0% |
| **Subtotal** | **604,800/mo** | **51,840/mo** | **−91.4%** |

### 3.2 Variable cost — cache

Structural change: **before, cost was 2 commands per request with no ceiling. After, it is
capped at 1 command per key per L1 TTL, regardless of request rate.**

Worked example — 10 hosted projects × 3 entities, 300K requests/month, 12h/day active window,
95% reads:

| Source | Before | After (defaults) | After (single-replica tuning) |
|---|---:|---:|---:|
| Hosted config `GET`/`SET` | ~450,000 | ~7,200 | ~7,200 |
| Seed `GET`/`SET`/`DEL` | ~600,000 | ~285,000 | ~43,000 |
| Write-through | (in above) | ~15,000 | ~15,000 |
| **Cache subtotal** | **~1,050,000** | **~307,000** | **~65,000** |

### 3.3 Total

| | Before | After (defaults) | After (tuned) |
|---|---:|---:|---:|
| Queue (1 worker) | 604,800 | 51,840 | 51,840 |
| Cache | ~1,050,000 | ~307,000 | ~65,000 |
| Enqueue + job lifecycle (~500 jobs) | ~8,000 | ~8,000 | ~8,000 |
| **Total** | **~1,663,000** | **~367,000** | **~125,000** |
| **% of 500K plan** | **333%** | **73%** | **25%** |
| **Reduction** | — | **−78%** | **−92.5%** |

Numbers are illustrative and assumption-sensitive; the fixed-cost figures in §3.1 are exact.
Use `/healthz` (§2.2) for actual per-replica counts.

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | 43/43 tasks pass |
| `pnpm test` | 42/42 tasks pass — 25 mock-runtime, 61 API, 11 workers, 28 registry, 10 db |
| `pnpm lint` (eslint + dependency-cruiser) | Clean — 2 pre-existing warnings, unrelated |
| New tests | 13 in `packages/cache/src/cache.test.ts`, all passing |

The new tests assert **command volume**, not just behavior: e.g. 10 reads of a hot key produce
exactly `['get k', 'set k']`, and 8 concurrent misses produce one loader call.

No breaking changes: `createRedisCache` is retained as a deprecated alias, `CacheClient` keeps
its original shape, and `CacheService` implements it.

---

## 5. Recommended deployment settings

```bash
# Free-tier single-replica mock runtime: no second replica can write behind
# your back, so L1 can hold seed records as long as Redis would.
CACHE_SEED_L1_TTL_SECONDS=900

# Run exactly one worker. Two workers = two idle-poll bills.
RUN_WORKER_IN_PROCESS=true    # and do NOT also deploy apps/workers
```

If you scale the mock runtime past one replica, drop `CACHE_SEED_L1_TTL_SECONDS` back to `5`.

---

## 6. Remaining bottlenecks

1. **Seed reads at default settings (~285K/mo in the §3.2 model).** The 5s seed L1 TTL is
   conservative for multi-replica safety. §5 removes this for single-replica deployments.
   A proper fix for multi-replica would be Redis pub/sub L1 invalidation — but that adds
   a subscriber connection and its own commands, so it is only worth it above ~3 replicas.
2. **Idle worker floor: ~52K/mo/worker, unavoidable while a worker is running.** BullMQ has no
   zero-poll mode. If generation volume is low, the larger win is not running a worker at all —
   trigger generation on demand rather than keeping a resident consumer.
3. **`removeOnFail: false` grows Redis memory without bound** on a 30MB plan. Failed jobs are
   only cleared when the same idempotency key is re-enqueued; a project generated once and never
   retried keeps its failed job forever. One-line fix when you are ready to accept the retention
   change: `removeOnFail: { count: 100 }`.
4. **No cross-process view of command usage.** `/healthz` reports per-replica counters only.
   Redis Cloud's own dashboard remains the source of truth for the monthly total.

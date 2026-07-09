# 14 · Performance

← [13 · Security](./13-security.md) · [Master Index](./README.md) · Next: [15 · Testing](./15-testing.md)

The performance target is the product's North Star: **requirement → full backend toolkit in under 3 minutes** (doc 02). Everything below serves that budget, plus keeping the hosted mock API fast under public traffic.

---

## 1. Where the Time Budget Goes

A typical project (≤ 5 entities) must finish well inside 3 minutes. The dominant cost is generation, so the strategy is: **do less, do it in parallel, and show it as it lands.**

```
Parse (ms)  →  Review (user time, not counted)  →  Generate (the budget)
Generate = max over the DAG's critical path, not the sum of all workers
```

## 2. Parallel Workers (the biggest lever)

- Independent generators run **concurrently** at DAG level 0 — A (JSON Schema), B (Zod/Yup), C (TypeScript), D (Mock Data) all start at once (doc 09, §6; doc 10, §4).
- E (docs) and F (hosting) start the moment D completes; G (export) bundles last.
- Wall-clock time ≈ the **critical path** (`IPS → D → E/F → G`), not the sum of every worker. Adding worker replicas increases throughput across concurrent jobs.

## 3. Lazy / Selective Generation

- Only the workers implied by `generationConfig` run — no validator the user didn't pick, no hosting if no methods were selected (doc 09, §5). The cheapest work is the work skipped.
- **Per-asset regeneration** re-runs a single generator instead of the whole set (doc 04, §F13), so iterating on one schema costs one worker, not seven.

## 4. Streaming Results (perceived performance)

- The Progress board is fed by **SSE** from the API off Registry status changes (doc 08, `/jobs/{id}/stream`; doc 10, §8). Each artifact flips to ✓ as it finishes — the user sees continuous motion instead of one long spinner.
- Completed artifacts are **usable immediately** (View/Download) before slower siblings finish; the hosted API can come up as soon as F completes even if G is still zipping.

## 5. Caching (Redis)

| Cached | Why | Invalidation |
|---|---|---|
| **Current IPS per project** | Read on every generate/regenerate and by the mock runtime | On IPS edit / new version |
| **Hosted-API routing config** | Read on *every* hosted request — must not hit Mongo each time | On (re)generation of hosting / expiry |
| **Plan limits** | Checked on job creation and rate limiting | On plan change |

Redis sits alongside the BullMQ queue (doc 06), so caching adds no new infrastructure.

## 6. Hosted Mock API Performance

- **Config + seed reads are Redis-cached**, so a hosted request resolves routing and validation without a Mongo round-trip on the hot path (doc 13, §4 keeps this within tenant isolation).
- **Pagination bounds** (max `limit` 100) keep list responses small and predictable.
- The mock runtime is a **separate service** (doc 05/06), so public hosted-API traffic never starves the dashboard/API of resources.
- Writes mutate the project's isolated `mockStores`; reads serve from cache-warmed seed data.

## 7. Background Generation

- Generation is fully **asynchronous**: `POST /generate` returns `202` immediately with a `jobId` (doc 08, §4); work happens on the worker pool.
- The user can **leave the Progress screen**; the job continues and completion is pushed via notification/toast (doc 03, §S5). No long-held HTTP requests, no blocked UI thread.

## 8. Database & Storage Efficiency

- **Blobs live in object storage**, not Mongo — documents stay small (metadata + `storageRef`), keeping queries and the working set lean (doc 07).
- **Targeted indexes** back every hot query: dashboard listing, Registry lookups, cleanup scans, idempotency (doc 07, §3).
- The **cleanup worker** hard-deletes expired hosted assets on schedule, bounding storage growth and keeping collections small (doc 10, §9).

## 9. Frontend Performance

- Next.js: server components for the mostly-static dashboard shell; client components only where interactivity is needed (Builder, Review, Progress) (doc 06).
- Countdowns tick **client-side** from `expiresAt` — no polling for time.
- A client cache (TanStack Query *(alt)*) dedupes and reuses project/artifact reads; artifact **content** is fetched lazily on View, not upfront.
- Design-system motion is light and reduced-motion-aware (doc 12), avoiding jank.

## 10. Scalability Model

- **Stateless workers** scale horizontally — throughput grows with replicas; the queue smooths bursts (doc 10, §2).
- Each app (`web`, `api`, `mock-runtime`, `workers`) scales on its **own axis**: hosted-API traffic scales `mock-runtime`; generation load scales `workers`; dashboard load scales `web`/`api` (doc 05, §7).
- Plan concurrency caps protect cost/fairness without throttling infra tuning, which is a separate per-replica axis (doc 10, §5).

## 11. Performance Budgets & Monitoring

| Metric | Target |
|---|---|
| Full generation (≤ 5 entities) | Comfortably < 3 min (critical-path bound) |
| First artifact visible on board | Within a few seconds of Generate |
| Hosted-API p50 latency | Low, cache-served (no Mongo on hot path) |
| Queue wait (within plan slot) | Near-zero when a slot is free |

Tracked via per-job duration vs. budget, per-task timings, queue depth/latency, and hosted-API latency (doc 10, §10). Regressions in critical-path time are the primary alarm.

---

Next: [15 · Testing →](./15-testing.md)

# 06 · Tech Stack

← [05 · Monorepo Architecture](./05-monorepo-architecture.md) · [Master Index](./README.md) · Next: [07 · Database Design](./07-database-design.md)

> These are recommended choices for V1. Anything marked *(alt)* is an acceptable substitute; the architecture in [05](./05-monorepo-architecture.md) does not depend on the specific vendor as long as the package boundaries hold.

---

## 1. At a Glance

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | One language across apps + shared packages; the IPS types flow end-to-end |
| Frontend | **Next.js (React)** + **Tailwind CSS** | App Router for the wizard/dashboard; Tailwind pairs with the shared `ui` tokens |
| Core API | **Fastify** (Node.js) *(alt: NestJS)* | Fast, schema-first, light; orchestrates jobs, not heavy business frameworks |
| Mock runtime | **Fastify** with dynamic routing | Needs cheap per-request routing to serve `/p/{projectId}/{entity}` |
| Workers | **Node.js** worker process | Hosts the pure generator packages; scales independently |
| Queue | **BullMQ** on **Redis** | Mature job queue: retries, backoff, concurrency, delayed jobs (for reminders) |
| Cache | **Redis** | Same cluster as the queue; caches IPS + hosted-API config lookups |
| Database | **MongoDB** | Locked decision; document model fits the nested IPS and artifact records |
| Object storage | **S3-compatible** (AWS S3 / R2 / MinIO) | Generated files + ZIP bundles live here, not in Mongo |
| Auth | **JWT sessions** + OAuth provider *(alt: Clerk/Auth.js)* | Stateless auth shared by `api` and `mock-runtime` |
| Deployment | **Containers** (Docker) | Each app deploys and scales on its own axis |
| Package mgmt | **pnpm workspaces** + **Turborepo** | Cached, affected-only builds across the monorepo |

## 2. Frontend

- **Next.js (React) + TypeScript.** App Router; server components for the dashboard shell, client components for the interactive Schema Builder, Review tree, and live Progress board.
- **Tailwind CSS** consuming the design tokens from `packages/ui` (radius, spacing, color system, typography — see doc 12, Design System).
- **State:** local component state for the wizard; a lightweight client cache (TanStack Query *(alt)*) for project/artifact/job data fetched from the API.
- **Live updates:** the Progress board and expiration countdowns need push. V1 uses **Server-Sent Events (SSE)** from the API for job/worker progress *(alt: WebSocket)*; countdowns tick client-side from `expiresAt`.
- **Talks to the API over HTTP only** — the web app never imports server packages (enforced per doc 05, §4).

## 3. Core API (`apps/api`)

- **Fastify** with typed routes; request/response validation from shared schemas so the platform dogfoods strict input validation (doc 13, Security).
- Responsibilities: auth, projects, **job creation + enqueue**, artifact/registry reads, versioning, billing/plan checks, expiry reminders scheduling.
- **Does not generate artifacts inline** — it enqueues a Generation Job and returns immediately; workers do the work (doc 09, doc 10).
- Emits SSE streams for job progress by subscribing to registry status changes.

## 4. Mock Runtime (`apps/mock-runtime`)

- Separate Fastify app serving the **hosted mock APIs** at `https://api.InstantMockAPI.dev/p/{projectId}/{entity}`.
- On request: resolve project + entity → load hosted-API config and seed data (Redis-cached, backed by Mongo) → route the selected HTTP method → validate writes against generated rules → respond.
- **Isolation:** every project's mock store is namespaced; one project can never read another's data.
- Enforces per-project **rate limits** and writes **request logs / basic analytics**.
- Runs on its own service so hosted-API traffic never competes with dashboard/API traffic for resources.

## 5. Workers (`apps/workers`)

- Node.js process consuming BullMQ jobs; each job step invokes a **pure generator package** (`generators/*`) with `(IPS, generationConfig)` and writes the result to the Artifact Registry + object storage.
- **Stateless and horizontally scalable** — add worker replicas to increase throughput; concurrency per replica is configurable.
- Also hosts the **scheduled cleanup worker** (expiry hard-delete) and the **reminder worker** (pre-expiry emails), both driven by delayed/repeatable BullMQ jobs.

## 6. Queue & Cache (Redis + BullMQ)

- **BullMQ** provides: per-worker concurrency, exponential **backoff retries**, **delayed jobs** (expiry reminders, scheduled cleanup), and idempotency via job IDs (doc 10, §Concurrency).
- **Redis cache** holds hot reads: current IPS per project, hosted-API routing config, and plan limits — keeping the mock runtime fast and sparing Mongo on every mock request.

## 7. Database (MongoDB) — summary

Full schema in [07 · Database Design](./07-database-design.md). At a glance: collections for `users`, `projects` (the surviving shell + current IPS), `versions` (IPS/config snapshots), `artifacts` (the Registry), `jobs`, `mockStores` (hosted seed data), and `apiLogs`. Expiry is handled by a **scheduled cleanup worker** plus TTL on the *ephemeral* collections only — never on `projects`, since the shell must survive (doc 07, §Expiry & TTL).

## 8. Object Storage

- Generated artifact files (Zod/TS/JSON Schema files, OpenAPI/Postman JSON, scaffolds) and **ZIP export bundles** are stored in S3-compatible storage, referenced by `storageRef` in each artifact record.
- On expiry, the cleanup worker deletes these objects as part of the hosted-asset hard delete.
- Keeps Mongo documents small (metadata + refs, not blobs).

## 9. Authentication & Authorization

- **JWT** access tokens issued after login (OAuth provider or email) *(alt: Clerk/Auth.js for managed auth)*.
- Shared `packages/auth` verifies tokens in both `api` and `mock-runtime`.
- Authorization: every project operation checks ownership; plan gates (concurrency, lifetime) resolve from `packages/config`. Details in doc 13 (Security).

## 10. Deployment & Environments

- **Containerized** apps (`web`, `api`, `mock-runtime`, `workers`) deployed independently — e.g., web on Vercel *(alt)* or a container platform; `api`/`mock-runtime`/`workers` on Railway / Render / Fly.io / AWS ECS *(alt)*.
- Managed **MongoDB** (Atlas *(alt)*), managed **Redis**, and an **S3-compatible bucket**.
- Envs: `local → staging → production`; config via `packages/config` reading environment variables (no secrets in code).
- CI runs Turborepo affected-only `lint · typecheck · test · build`; dependency-cruiser enforces the import graph (doc 05, §4).

## 11. Future / AI Stack (pointer)

Natural-language requirement parsing, relationship detection, and validation suggestions (doc 18, AI Roadmap) will add an inference service that produces an IPS draft — plugging in as **another parser adapter**, so the rest of the pipeline is unchanged.

---

Next: [07 · Database Design →](./07-database-design.md)

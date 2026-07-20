# InstantMockAPI — Task Tracker

## Phase 1 — Foundation (Monorepo + Shared Packages)
- [x] Initialize monorepo: pnpm workspaces + Turborepo
- [x] Set up `tooling/` — shared ESLint, Prettier, tsconfig base (strict mode)
- [x] Set up dependency-cruiser rules
- [x] Create `packages/shared` — Logger, structured errors, Result type
- [x] Create `packages/config` — env loading, plan limits
- [x] Create empty `apps/` shells (api, web, workers, mock-runtime)
- [x] Create empty `packages/` shells (ips, parsers, generators/*, queue, registry, db, auth, ui)
- [x] Set up CI pipeline (lint → typecheck → test → build)
- [x] Conventional Commits hook (commitlint)

## Phase 2 — IPS Core
- [x] `packages/ips` — full IPS TypeScript types
- [x] IPS meta-schema validator + depth cap
- [x] IPS versioning utilities
- [x] `packages/parsers` — json-adapter
- [x] `packages/parsers` — builder-adapter
- [x] Tests: IPS validation + parser fixture suites

## Phase 3 — Generator Engine (Workers A–D)
- [x] Worker B — Zod generator
- [x] Worker B — Yup generator
- [x] Worker A — JSON Schema generator
- [x] Worker C — TypeScript generator
- [x] Worker D — Mock Data generator (Faker)
- [x] Golden-file tests for all generators

## Phase 4 — Backend Infrastructure
- [x] `packages/db` — MongoDB models + indexes
- [x] `packages/registry` — Artifact Registry
- [x] `packages/queue` — BullMQ job abstractions
- [x] `packages/auth` — JWT + AuthZ
- [x] `apps/api` — Core REST API (Fastify)
- [x] Tests: registry state machine, API contracts, idempotency

## Phase 5 — Worker Pipeline
- [x] Worker E — OpenAPI + Postman generator
- [x] Worker F — Hosting config generator
- [x] Worker G — Export/ZIP generator
- [x] Object storage integration (S3)
- [x] `apps/workers` — Job orchestration + DAG scheduler
- [x] SSE progress streaming
- [x] Tests: DAG ordering, retry, selective generation, full pipeline

## Phase 6 — Frontend
- [x] `packages/ui` — Design system + shared components _(ValidationPopover, Toast, Drawer still pending)_
- [x] S1 Dashboard
- [x] S2 Input (Paste JSON + Manual Schema Builder + Swagger) _(builder is flat fields — nesting + per-field validation popover pending)_
- [x] S3 Configure
- [x] S4 Review
- [x] S5 Progress
- [x] S6 Project Page
- [x] S7 Expired State
- [x] S8 Settings & Billing _(billing wiring post-V1; plan display only)_
- [x] S9 Templates
- [x] Client data layer (TanStack Query + SSE)

> Visual note: implemented from `plan/12-design-system.md` tokens (blueprint indigo/cyan).
> The MockForge design link (claude.ai artifact 07fcb8bc…) fails to load server-side;
> once the file is available, re-skinning = swapping tokens in `packages/ui/styles.css`.

## Phase 7 — Mock Runtime (parallel with Phase 6)
- [x] `apps/mock-runtime` — Fastify CRUD server
- [x] Redis caching for hosted config/data
- [x] Tests: CRUD, 405/422, tenant isolation, pagination, expiry

## Phase 8 — Integration & Launch
- [ ] Expiry system (cleanup + reminder workers)
- [ ] Security hardening
- [ ] E2E tests (Playwright)
- [ ] Performance validation
- [ ] Deployment (Docker, CI/CD, domains)
- [ ] Documentation

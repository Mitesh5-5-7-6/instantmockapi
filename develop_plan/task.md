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
- [ ] `packages/db` — MongoDB models + indexes
- [ ] `packages/registry` — Artifact Registry
- [ ] `packages/queue` — BullMQ job abstractions
- [ ] `packages/auth` — JWT + AuthZ
- [ ] `apps/api` — Core REST API (Fastify)
- [ ] Tests: registry state machine, API contracts, idempotency

## Phase 5 — Worker Pipeline
- [ ] Worker E — OpenAPI + Postman generator
- [ ] Worker F — Hosting config generator
- [ ] Worker G — Export/ZIP generator
- [ ] Object storage integration (S3)
- [ ] `apps/workers` — Job orchestration + DAG scheduler
- [ ] SSE progress streaming
- [ ] Tests: DAG ordering, retry, selective generation, full pipeline

## Phase 6 — Frontend
- [ ] `packages/ui` — Design system + shared components
- [ ] S1 Dashboard
- [ ] S2 Input (Paste JSON + Manual Schema Builder + Swagger)
- [ ] S3 Configure
- [ ] S4 Review
- [ ] S5 Progress
- [ ] S6 Project Page
- [ ] S7 Expired State
- [ ] S8 Settings & Billing
- [ ] S9 Templates
- [ ] Client data layer (TanStack Query + SSE)

## Phase 7 — Mock Runtime (parallel with Phase 6)
- [ ] `apps/mock-runtime` — Fastify CRUD server
- [ ] Redis caching for hosted config/data
- [ ] Tests: CRUD, 405/422, tenant isolation, pagination, expiry

## Phase 8 — Integration & Launch
- [ ] Expiry system (cleanup + reminder workers)
- [ ] Security hardening
- [ ] E2E tests (Playwright)
- [ ] Performance validation
- [ ] Deployment (Docker, CI/CD, domains)
- [ ] Documentation

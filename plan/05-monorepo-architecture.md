# 05 · Monorepo Architecture

← [04 · Feature Specification](./04-feature-specification.md) · [Master Index](./README.md)

---

## 1. Why a Monorepo

Seven workers, a web app, an API, a hosted-mock-API runtime, and a dozen generators all consume **one shared model — the IPS**. A monorepo keeps the IPS types, validation-rule definitions, and generator contracts in shared packages so nothing drifts: change the IPS shape once, every consumer fails to compile until updated.

## 2. Folder Structure

```
InstantMockAPI/
│
├── apps/
│   ├── web/                    # Dashboard, wizard, review, progress, project pages
│   ├── api/                    # Core REST API (projects, jobs, artifacts, auth, billing)
│   ├── mock-runtime/           # Serves hosted mock APIs (api.InstantMockAPI.dev/p/…)
│   └── workers/                # Worker host process(es) — consumes queue jobs
│
├── packages/
│   ├── ips/                    # Internal Project Schema: types, validation, versioning, depth cap
│   ├── parsers/                # Input adapters: json, swagger, docs (builder edits IPS directly)
│   ├── generators/
│   │   ├── schema/             # Worker A  → JSON Schema
│   │   ├── validation/         # Worker B  → Zod, Yup
│   │   ├── types/              # Worker C  → TypeScript, DTOs
│   │   ├── mock-data/          # Worker D  → faker records, seed files
│   │   ├── docs/               # Worker E  → OpenAPI, Postman
│   │   ├── hosting/            # Worker F  → mock-runtime configuration
│   │   ├── export/             # Worker G  → ZIP bundling
│   │   └── stretch/            # Prisma, Drizzle, Mongo, Supabase SQL, NestJS, Express
│   ├── queue/                  # Job/queue abstractions, retry policy, idempotency keys
│   ├── registry/               # Artifact Registry: records, status transitions, versions
│   ├── db/                     # MongoDB models, indexes, cleanup queries
│   ├── auth/                   # AuthN/AuthZ helpers shared by api + mock-runtime
│   ├── config/                 # Env/config loading, plan limits (2/7/30 days, 1/3/∞ jobs)
│   ├── ui/                     # Shared React components + design tokens (see 12)
│   └── shared/                 # Logger, errors, result types, utilities
│
├── tooling/                    # ESLint, TS configs, build scripts, codegen
├── docs/                       # This documentation set
└── package.json                # Workspace root (pnpm workspaces + Turborepo)
```

## 3. Package Responsibilities

| Package | Owns | Must NOT do |
|---|---|---|
| `ips` | IPS types, schema validation, version snapshots, nesting depth cap | Import anything except `shared` |
| `parsers` | Source format → IPS | Emit any generated output |
| `generators/*` | IPS → one artifact type each | Read raw input, touch DB or queue |
| `queue` | Enqueue/consume jobs, retries, idempotency | Contain business logic |
| `registry` | Artifact records, status machine, versioning | Render UI, generate artifacts |
| `db` | Persistence, indexes, expiry cleanup queries | Business rules |
| `apps/api` | HTTP endpoints, orchestration: create job → enqueue → registry | Generate artifacts inline |
| `apps/workers` | Wire queue jobs to generator packages, report to registry | Serve HTTP to end users |
| `apps/mock-runtime` | Route + serve hosted mock APIs from stored config/seed data | Run generators |
| `apps/web` | All UI | Import generators or db directly (talks to `apps/api` only) |

## 4. Dependency Graph (arrows = "may depend on")

```
                 shared
                   ▲
        ┌──────────┼───────────┐
        │          │           │
       ips       config      auth
        ▲          ▲           ▲
   ┌────┴────┐     │           │
parsers  generators/*          │
   ▲          ▲                │
   │          │                │
   └── queue ─┤                │
        ▲     │                │
     registry ┤                │
        ▲     │                │
        db ───┘                │
        ▲                      │
 ┌──────┼──────────┬───────────┤
apps/api   apps/workers   apps/mock-runtime
        ▲
     apps/web  (HTTP only — no package import of db/generators)
```

**Hard rules:**
1. Dependencies point **downward only** — no package imports an app; no cycles (enforced in CI via dependency-cruiser).
2. `generators/*` are **pure**: `(IPS, generationConfig) → artifact content`. No I/O, no DB, no network. This is what makes them trivially testable and worker-hostable.
3. Only `apps/api` creates jobs; only `apps/workers` executes them; only `registry` changes artifact status.
4. `apps/web` communicates exclusively over the REST API — never imports server packages.

## 5. Shared Packages in Practice

- **`ips`** is the contract. Its exported TypeScript types are consumed by every parser, generator, the registry, and the web app (via the API's typed client). One IPS change → compiler surfaces every affected site.
- **`config`** centralizes plan limits so "Free = 2 days, 1 job" lives in exactly one place.
- **`ui`** holds design tokens (radius, spacing, color system, typography) per doc 12 (Design System) — the web app composes screens only from these components.

## 6. Coding Rules (summary — full detail in 17 · Coding Standard)

1. **Naming:** packages kebab-case; types PascalCase; one artifact generator per folder named after its output.
2. **Folders:** feature-first inside apps (`apps/web/src/features/review/…`); no `utils` dumping grounds — utilities go to `shared` with tests.
3. **Boundaries:** import rules from §4 are lint-enforced; PRs that violate the graph fail CI.
4. **Testing:** every generator ships golden-file tests (IPS fixture in → expected artifact out); parsers ship fixture suites per input format; registry status machine has exhaustive transition tests.
5. **Commits:** Conventional Commits (`feat(generators/zod): …`); one package per PR where feasible.

## 7. Build & Tasks

- **pnpm workspaces + Turborepo**: `build`, `test`, `lint`, `typecheck` cached per package; affected-only pipelines in CI.
- Apps deploy independently (web / api / workers / mock-runtime scale on separate axes — see doc 06, Tech Stack).

---

Back to [Master Index](./README.md)

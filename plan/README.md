# InstantMockAPI — Documentation

> **Backend Development Studio** — turn API requirements, JSON payloads, or a manual schema into a complete backend toolkit in under 3 minutes.

InstantMockAPI is a **Backend Generation Platform**, not a database service. It parses developer input into a single Internal Project Schema, then generates schemas, validations, types, mock data, documentation, server scaffolds, exports — and hosts a temporary Mock REST API for frontend development.

**Core philosophy:** Write Requirements Once. Generate Everything. Review Once. Deploy Instantly.

---

## Documentation Index

| # | Document | Purpose | Status |
|---|---|---|---|
| — | [README.md](./README.md) | Master index (this file) | ✅ |
| 01 | [Product Vision](./01-product-vision.md) | Why InstantMockAPI exists, audience, market gap, philosophy, business model | ✅ |
| 02 | [PRD](./02-prd.md) | Product requirements: goals, personas, functional & non-functional requirements, scope, metrics | ✅ |
| 03 | [User Flow](./03-user-flow.md) | Complete journey, wizard steps, decision tree, screens, failure & expiry flows | ✅ |
| 04 | [Feature Specification](./04-feature-specification.md) | Detailed spec for every core feature | ✅ |
| 05 | [Monorepo Architecture](./05-monorepo-architecture.md) | Folder structure, packages, dependency graph, coding rules | ✅ |
| 06 | [Tech Stack](./06-tech-stack.md) | Frontend, backend, DB, queues, storage, deployment choices | ✅ |
| 07 | [Database Design](./07-database-design.md) | Collections, indexes, TTL/expiry model, artifact registry schema | ✅ |
| 08 | [API Design](./08-api-design.md) | REST conventions, auth, pagination, errors, rate limits, versioning | ✅ |
| 09 | [Generator Engine](./09-generator-engine.md) | Parser → Internal Schema → generator pipeline | ✅ |
| 10 | [Worker Engine](./10-worker-engine.md) | Workers A–G, queue, retries, progress aggregation | ✅ |
| 11 | [UI / UX](./11-ui-ux.md) | Screen-by-screen UI specification | ✅ |
| 12 | [Design System](./12-design-system.md) | Colors, typography, spacing, radius, components | ✅ |
| 13 | [Security](./13-security.md) | AuthN/AuthZ, input validation, abuse prevention | ✅ |
| 14 | [Performance](./14-performance.md) | Caching, parallelism, streaming, lazy generation | ✅ |
| 15 | [Testing](./15-testing.md) | Testing strategy and rules | ✅ |
| 16 | [Roadmap](./16-roadmap.md) | V1 → V2 → V3 | ✅ |
| 17 | [Coding Standard](./17-coding-standard.md) | Naming, folders, commits, architecture rules | ✅ |
| 18 | [AI Roadmap](./18-ai-roadmap.md) | Future AI: requirement understanding, Figma, OCR | ✅ |

---

## How to Read These Docs

- **New to the project?** Read 01 → 02 → 03 in order. That gives you the *why*, the *what*, and the *how it feels to use*.
- **Building the frontend?** 03 (User Flow) → 04 (Features) → 11 (UI/UX) → 12 (Design System).
- **Building the backend?** 04 → 05 (Monorepo) → 07 (Database) → 09 (Generator Engine) → 10 (Worker Engine).
- **Making a product decision?** Check 02 (PRD) first — it records all resolved decisions and scope boundaries.

## Locked Product Decisions (quick reference)

These decisions are final for V1 and are reflected consistently across all documents:

| Topic | Decision |
|---|---|
| Schema nesting | Unlimited practical depth (objects, arrays, arrays of objects, dynamic "Add Another") |
| Entity relationships | Deferred to V2 |
| Validators in V1 | **Zod + Yup only** (JSON Schema under "Advanced"; Joi/Valibot deferred) |
| Validation model | Layer 1 automatic detection + Layer 2 per-field custom configuration |
| Seed data | Always generated for readable endpoints — GET-only APIs are read-only |
| Concurrency | Free: 1 active job · Pro: 3 parallel jobs · Enterprise: unlimited |
| Expiration | Free: 2 days · Pro: 7 days · Enterprise: 30 days |
| Expiry behavior | **Hard delete hosted assets** (API, files, mock data, caches) — **keep project shell** (name, input, internal schema, config, history) → one-click "Generate Again" |
| Failed generation | Workers are independent; retry only the failed worker |
| Regeneration | Per-asset regeneration supported |
| Versioning | Every generation creates a new version; versions are restorable |
| Artifact tracking | Every artifact tracked independently in a **Project Artifact Registry** (status, version, timestamp, worker ID, error) |

## Glossary

| Term | Meaning |
|---|---|
| **Internal Project Schema (IPS)** | The single normalized model every input is parsed into and every generator reads from. The single source of truth. |
| **Generation Job** | One user-triggered generation run, fanned out to workers via the queue. |
| **Worker A–G** | Independent background workers: Schema, Validation, Types, Mock Data, Documentation, API Hosting, Export. |
| **Artifact** | One generated output (e.g., the Zod file, the OpenAPI spec, the Hosted API) tracked in the Artifact Registry. |
| **Hosted Mock API** | Temporary, project-isolated CRUD REST API served from generated seed data. |
| **Project shell** | What survives expiry: project name, original input, IPS, configuration, version history. |

# InstantMockAPI — My Understanding

> Backend Development Studio · A Backend **Generation** Platform (not a database service)

---

## 1. What This Project Is

InstantMockAPI is a developer platform that takes backend requirements — a JSON payload, API docs, Swagger/OpenAPI, or a manual schema built in the UI — and automatically generates a **complete, development-ready backend toolkit** from a single source of truth.

It is explicitly **not** a Supabase/Firebase competitor. It does not store production data. It is a **generation engine**: it analyzes input, builds an Internal Project Schema, fans out to parallel background workers, and produces every backend asset a frontend developer needs — including an optional **temporary hosted Mock REST API**.

### Core Philosophy

> **Write Requirements Once. Generate Everything. Review Once. Deploy Instantly.**

### The Main Goal (North Star Metric)

A developer should go from raw requirement → full backend development environment in **under 3 minutes**, instead of spending hours hand-writing schemas, validations, types, mock data, docs, and CRUD endpoints.

---

## 2. The Problem It Solves

Frontend developers are blocked when the backend doesn't exist yet. Today they manually create:

- JSON Schema
- Zod / Yup / Joi / Valibot validations
- TypeScript types, interfaces, DTOs
- CRUD endpoints for testing
- Mock/seed data
- OpenAPI / Swagger / Postman docs

All of these describe the **same data model**, yet they're written separately and drift out of sync. InstantMockAPI generates all of them from **one internal model**, so every output is always consistent.

---

## 3. Generated Assets (Full List)

| Category | Outputs |
|---|---|
| Schema | JSON Schema, Mongo Schema, Prisma, Drizzle, Supabase SQL |
| Validation | Zod, Yup (V1) · Joi, Valibot (deferred) |
| Types | TypeScript interfaces, DTOs |
| Mock Data | Faker-based data, seed files, example responses |
| Documentation | OpenAPI, Swagger, Postman Collection |
| Server Code | NestJS, Express scaffolds |
| Live API | Hosted temporary Mock CRUD API (GET/POST/PUT/PATCH/DELETE) |
| Exports | ZIP bundle of everything |

---

## 4. Supported Inputs

**Now (V1):**
- JSON payload (paste a sample response)
- API documentation / existing backend docs
- Swagger / OpenAPI file
- Manual Schema Builder (form-based UI)

**Future (AI roadmap):**
- Figma design import
- Screenshot / OCR
- PDF requirements
- Natural-language requirements (AI requirement understanding)

Every input source, regardless of format, is normalized into the same **Internal Project Schema** — the heart of the system.

---

## 5. The Core User Flow (as clarified)

This is the primary interactive flow to build first:

```
1. User enters a custom schema
   (dynamic fields: name, type, required, defaults, nested objects, arrays…)
        │
        ▼
2. System asks configuration questions:
   ┌─────────────────────────────────────────────┐
   │ • Validation needed?      [ ] Zod  [ ] Yup  │
   │ • Schema types needed?    [ ] TypeScript    │
   │ • API methods (checkbox): [ ] GET  [ ] POST │
   │                           [ ] PUT  [ ] PATCH│
   │                           [ ] DELETE        │
   └─────────────────────────────────────────────┘
        │
        ▼
3. User reviews the generated internal model (Review Screen)
        │
        ▼
4. Click "Generate" → Job created → Queue → Workers run in parallel
        │
        ▼
5. Live Progress Screen
   ✓ Schema  ✓ Validation  ✓ Types  ✓ Mock Data  ✓ Docs  ⏳ Hosted API
        │
        ▼
6. Success Screen → download assets + hosted Mock API URL
```

Key implication: generation is **selective**. The user's checkbox answers determine which workers run and which assets are produced — we never blindly generate everything.

---

## 6. High-Level Architecture

```
User Input ──► Requirement Parser ──► Internal Project Schema ──► User Review
                                                                      │
                                                              Click Generate
                                                                      │
                                                            Generation Job
                                                                      │
                                                              Queue Manager
                                                                      │
              ┌───────────┬───────────┬───────────┬──────────────────┤
              ▼           ▼           ▼           ▼                  ▼
         Worker A     Worker B    Worker C    Worker D          (parallel)
          Schema     Validation    Types      Mock Data
              └───────────┴─────┬─────┴───────────┘
                                ▼
                     Worker E: Documentation (OpenAPI/Swagger/Postman)
                                ▼
                     Worker F: API Hosting (CRUD, hosted URL)
                                ▼
                     Worker G: Export (ZIP/JSON/TS bundles)
                                ▼
                    Progress Aggregator → MongoDB → Notify User
```

### Why background workers (never one big request)

- Parallel generation = speed (the 3-minute goal)
- Independent retries and failure handling per asset
- Live per-asset progress reporting to the dashboard
- Scales to distributed workers later

### Worker Responsibilities

| Worker | Job | Produces |
|---|---|---|
| A | Schema | JSON Schema |
| B | Validation | Zod, Yup (V1) · Joi, Valibot (deferred) |
| C | Types | TypeScript, interfaces, DTOs |
| D | Mock Data | Faker data, seed files, example responses |
| E | Documentation | OpenAPI, Swagger, Postman |
| F | API Hosting | Hosted CRUD endpoints + temporary URL |
| G | Export | ZIP / downloadable bundles |

Cross-cutting worker concerns: retry strategy, failure handling, progress reporting to a central aggregator that updates job status.

---

## 7. Internal Project Schema — Single Source of Truth

Every parser (JSON, Markdown docs, Swagger, Manual Builder, future AI) converts into **one common internal format**. Every generator reads **only** this model. This is the architectural rule that guarantees all outputs stay synchronized — a field renamed in the internal schema changes in the Zod schema, the TS types, the mock data, the docs, and the hosted API simultaneously.

Design consequence: the Internal Project Schema needs versioning (docs mention schema versioning in DB design) so regeneration and review diffs are possible.

---

## 8. Hosted Mock API

- Each project gets a **temporary hosted URL** with project isolation
- Full CRUD (GET/POST/PUT/PATCH/DELETE) backed by generated seed data
- Requests validated against the generated validation schema
- Rate limiting, request logging, and basic analytics per project

### Lifecycle & Expiration — **FINAL DECISION**

```
Create → Generate → Host → Active → Expire → Hard-delete hosted assets → "Generate Again"
```

**Plan-based expiration**, hard delete of hosted assets on expiry:

| Plan | Hosted API lifetime | On expiry |
|---|---|---|
| Free | 2 days | Hard delete hosted assets |
| Pro | 7 days | Hard delete hosted assets |
| Enterprise | 30 days | Hard delete hosted assets |

This naturally encourages upgrades (the business-model lever).

**What gets hard-deleted at expiry:**
- Hosted API configuration + temporary URL (routing entry)
- Generated files in storage
- Mock/seed data
- Temporary caches

**What is KEPT (the project shell survives):**
- Project name
- Original input
- Internal Project Schema
- Generation configuration
- History / versions

So the user sees: `CRM Backend — Expired — [Generate Again]`. One click → new hosted API, new mock data — no need to recreate anything.

Implementation notes:
- A MongoDB **TTL index** can't be used naively here since the project document must survive — instead, put `expiresAt` on the *hosted-asset* documents (or use a **nightly/scheduled cleanup worker** that hard-deletes hosted assets, storage files, and routing entries, then flips the project status to `expired`)
- Email/dashboard reminders before expiry + a prominent "Download ZIP" nudge remain good UX, but the safety net is now built in: regeneration is always one click away

---

## 9. Tech & Data (as specified in docs)

- **Monorepo** with shared packages, strict package responsibilities, and an enforced dependency graph / coding rules
- **Database:** MongoDB — collections with indexes, relationships, versioning; **plan-based expiry (2/7/30 days)** where hosted assets are hard-deleted by a cleanup worker while the project shell is kept for one-click regeneration
- **Queues + Workers** for the generation pipeline; caching layer for performance
- **API layer:** REST (GraphQL noted) with auth, pagination, filtering, searching, sorting, standardized errors, rate limits, API versioning
- **Storage** for generated assets/exports
- **Performance strategy:** caching, lazy generation, parallel workers, streaming results, background generation
- **Security:** authn/authz, input validation, rate limits, abuse prevention (critical since we host user-defined APIs)

---

## 10. UI / UX Surfaces

- **Dashboard** — projects list, statuses, expiration countdowns
- **Generator** — input upload/paste + the dynamic schema builder + config questions (validation? types? which HTTP methods?)
- **Review Screen** — inspect the parsed Internal Project Schema before generating
- **Progress Screen** — live per-worker checkmarks (generation "feels active")
- **Success Screen** — hosted URL, downloads, docs links
- **Project Page, Settings, Billing, Templates**
- **Design system** — defined radius, spacing, color system, typography tokens

---

## 11. Roadmap Shape

- **V1:** core inputs (JSON, Swagger, manual builder), workers A–G, hosted mock API, exports, expiration system
- **V2/V3:** more generators (Prisma/Drizzle/NestJS/Express deepening), templates, team features
- **Future AI:** requirement understanding from natural language, relationship detection, validation suggestions, backend assistant; plus Figma import, OCR, VS Code extension, CLI, desktop app, team collaboration

---

## 12. My Key Takeaways / Mental Model

1. **It's a compiler, not a database.** Input formats are "frontends," the Internal Project Schema is the IR, and each worker is a "backend target." Thinking of it this way keeps the architecture clean.
2. **Selective generation matters.** The clarified user flow (checkboxes for Zod/Yup, TypeScript, HTTP methods) means the job payload must carry a *generation config*, and the queue should only enqueue the workers the user selected.
3. **The Review step is a first-class feature**, not a formality — it's where trust is built before spending compute on generation.
4. **Expiration deletes hosted assets, never the project.** Plan-based lifetimes (2/7/30 days) drive upgrades; a cleanup worker hard-deletes hosted assets while the project shell + internal schema survive for one-click "Generate Again."
5. **Everything hinges on the Internal Project Schema spec.** It should be designed (and versioned) first, before any parser or generator is written.

## 13. Resolved Decisions (Open Questions — Answered)

### 1. Schema nesting depth → **Unlimited (with a practical abuse limit)**

The platform supports any valid JSON structure:

```json
{
  "primaryDetail": { "name": "", "email": "" },
  "addresses": [
    { "type": "home", "location": { "country": "", "state": "", "city": "" } }
  ],
  "education": [
    { "college": { "name": "", "address": { "city": "" } } }
  ]
}
```

Supported: nested objects, nested arrays, arrays of objects, arrays inside objects, objects inside arrays, recursive structures (limited), dynamic arrays ("Add Another").

**V2:** entity references, foreign keys, one-to-one, one-to-many, many-to-many.

### 2. Seed data when only GET is selected → **Always generate**

Rule: **every readable endpoint must have seed data.** If only GET is checked, the system still auto-generates fake records (e.g., 25 per entity) — the API is simply read-only when POST/PUT/PATCH/DELETE aren't enabled.

### 3. Validation configurability → **Two layers**

- **Layer 1 — automatic detection:** `email` → email validation, `phone` → phone validation, `url` → URL validation, etc.
- **Layer 2 — custom configuration per field:** Required, Nullable, Optional, Default, Min, Max, Length, Regex, Enum, Email, URL, UUID, Date, Number, Decimal, Integer, Array Length, Unique (metadata), Custom error messages.

This validation config lives in the Internal Project Schema and becomes the single source for all validation generators.

### 4. Validators in V1 → **Zod + Yup only** (plus JSON Schema as "Advanced")

Most React developers use Zod today. Joi/Valibot are deferred — adding every validator immediately increases maintenance without helping most users.

### 5. Concurrency model → **Plan-based job limits**

| Plan | Concurrent generation jobs |
|---|---|
| Free | 1 active generation |
| Pro | 3 parallel jobs |
| Enterprise | Unlimited |

Reason: a user clicking Generate 50 times shouldn't create 50 expensive jobs. Flow: User → Generation Job → Queue → Worker Pool → Completed. **Workers remain stateless.**

### 6. Expiration → **Plan-based: Free 2d / Pro 7d / Enterprise 30d** (hard delete of hosted assets)

See Section 8 for full details. Not a flat limit — the tiering encourages upgrades.

### 7. Expiry behavior → **Keep the project, delete only hosted assets**

Delete: hosted API, generated files, mock data, temp caches.
Keep: project name, input, internal schema, configuration, history.
Result: `Expired → [Generate Again]` — one click, new API, no recreation.

### 8. Failed generation → **Per-worker independence + individual retry**

The project never fails as a whole. Each worker succeeds or fails independently, and the user sees per-asset status:

```
JSON Schema  ✓        Types  ✓        Zod  ✓
Mock Data    ❌ Retry  Hosted API  ⏳ Waiting
```

Only the failed worker is retried — completed assets are untouched.

### 9. Per-asset regeneration → **Yes**

Users can regenerate a single asset (e.g., ☑ Zod only) without re-running everything. Saves time and compute.

### 10. Versioning → **Every generation creates a version**

```
Customer API → Version 1 → user edits schema → Version 2 → user restores Version 1
```

### Decision Summary

| Question | Decision |
|---|---|
| Nested objects | Unlimited practical depth |
| Dynamic arrays | ✅ Supported |
| Entity relationships | V2 |
| Seed data for GET | Always generate |
| Validation | Automatic detection + customizable per field |
| Validators in V1 | Zod + Yup only (JSON Schema advanced) |
| Concurrency | Free: 1 · Pro: 3 · Enterprise: Unlimited |
| Expiration | 2 / 7 / 30 days by plan |
| Expiry behavior | Hard-delete hosted assets, keep project shell |
| Failed generation | Retry individual workers |
| Regeneration | Per asset |
| Versioning | Every generation creates a version |

---

## 14. Architectural Addition: Project Artifact Registry

Instead of treating generated output as one blob, **track every artifact independently**:

```
Project
│
├── Internal Schema
├── JSON Schema
├── Zod
├── Yup
├── TypeScript
├── Mock Data
├── OpenAPI
├── Postman
├── Hosted API
└── Export Bundle
```

Each artifact record carries:

- **Status** — pending · generating · completed · failed
- **Version**
- **Generated timestamp**
- **Worker ID**
- **Error message** (if failed)

This registry is what makes decisions #8 (per-worker retry), #9 (per-asset regeneration), and #10 (versioning) implementable — the per-asset status UI, retry buttons, and version history all read directly from it. It should be a first-class MongoDB collection (`artifacts`), keyed by `projectId + artifactType + version`.

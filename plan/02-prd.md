# 02 · Product Requirements Document (PRD)

← [01 · Product Vision](./01-product-vision.md) · [Master Index](./README.md) · Next: [03 · User Flow](./03-user-flow.md)

---

## 1. Summary

InstantMockAPI converts backend requirements (JSON payload, Swagger/OpenAPI, or a manual schema built in the UI) into a complete backend toolkit — JSON Schema, Zod/Yup validations, TypeScript types, mock data, OpenAPI/Postman docs, ORM schemas, server scaffolds, a downloadable export bundle, and a temporary **hosted Mock CRUD API**.

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| Speed | Time from "New Project" to hosted API + downloadable assets | **< 3 minutes** (North Star) |
| Consistency | Assets generated from a single Internal Project Schema (IPS) | 100% — no generator reads raw input |
| Reliability | A single worker failure never fails the whole project | Per-worker retry, partial results always delivered |
| Activation | New user completes first full generation | Primary onboarding metric |
| Conversion | Expired Free projects → Pro upgrades or "Generate Again" clicks | Tracked per expiry event |

## 3. Non-Goals (V1)

- Production data storage or production API hosting
- Entity relationships / foreign keys (1-1, 1-N, N-N) — **V2**
- Joi and Valibot validator outputs — deferred
- GraphQL generation (REST only in V1)
- AI/natural-language requirement parsing, Figma import, OCR — see doc 18 (AI Roadmap)
- Team collaboration / multi-user projects

## 4. Personas

1. **Priya — Frontend developer.** Backend team is 2 sprints behind. Needs a realistic CRUD API + TS types today. Success: pastes a sample JSON response, gets a hosted API URL and types in minutes.
2. **Marcus — Freelance full-stack developer.** Starts a new client project monthly. Success: builds the schema once, downloads Zod + Prisma + NestJS scaffold + Postman collection as one ZIP.
3. **Ana — Agency tech lead.** Runs parallel client prototypes. Success: Pro plan's 3 concurrent jobs and 7-day APIs cover a sprint demo cycle.

## 5. Functional Requirements

### FR-1 · Project Management
- FR-1.1 Create, rename, and delete projects from a dashboard.
- FR-1.2 Dashboard shows per-project status (`draft · generating · active · expired`) and a live expiration countdown.
- FR-1.3 Expired projects display a one-click **Generate Again** action (see FR-9).

### FR-2 · Input & Parsing
- FR-2.1 Accept input via: **Paste JSON**, **Manual Schema Builder**, **Swagger/OpenAPI upload**, existing API documentation.
- FR-2.2 Every input is parsed into the **Internal Project Schema (IPS)** — the single source of truth for all generators.
- FR-2.3 JSON parsing infers field types and flags likely formats by key name (email, phone, url).

### FR-3 · Manual Schema Builder
- FR-3.1 Multiple entities per project.
- FR-3.2 Field types: string, number, decimal, integer, boolean, date, email, url, uuid, enum, object, array.
- FR-3.3 **Unlimited nesting** (practical depth cap to prevent abuse): nested objects, nested arrays, arrays of objects, objects inside arrays, limited recursive structures, dynamic arrays ("Add Another").
- FR-3.4 Per-field validation config — **Layer 2** (see FR-4).

### FR-4 · Validation (two layers)
- FR-4.1 **Layer 1 — automatic detection:** field name/type implies validation (email → email rule, phone → phone rule, url → URL rule).
- FR-4.2 **Layer 2 — custom configuration:** Required, Nullable, Optional, Default, Min, Max, Length, Regex, Enum, Email, URL, UUID, Date, Number, Decimal, Integer, Array Length, Unique (metadata), Custom error messages.
- FR-4.3 Validation config is stored **in the IPS** and consumed by every validation generator.
- FR-4.4 V1 validator outputs: **Zod, Yup** (checkboxes) + **JSON Schema** under an "Advanced" option.

### FR-5 · Generation Configuration (the question flow)
Before generation, the system asks:
- FR-5.1 Validation needed? ☑ Zod ☑ Yup (Advanced: ☐ JSON Schema)
- FR-5.2 Schema types needed? ☑ TypeScript
- FR-5.3 API methods (checkboxes): GET · POST · PUT · PATCH · DELETE
- FR-5.4 Mock records per entity (default 25).
- FR-5.5 Generation is **selective**: only workers matching the selected outputs are enqueued.

### FR-6 · Review Screen
- FR-6.1 User reviews the parsed IPS (entity/field tree with validation rules) before generating.
- FR-6.2 Inline edits allowed (rename field, toggle required, adjust rules).
- FR-6.3 Generation cannot start without passing through Review.

### FR-7 · Generation Job & Workers
- FR-7.1 One click on Generate creates **one Generation Job**, split across independent workers via a queue:
  A Schema · B Validation · C Types · D Mock Data · E Documentation · F API Hosting · G Export.
- FR-7.2 Live per-worker progress on a Progress screen (pending → generating → ✓ / ❌).
- FR-7.3 **Workers are independent.** A failed worker shows its error and a **Retry** button; completed assets are untouched; the project never fails as a whole.
- FR-7.4 Concurrency limits by plan: Free 1 active job · Pro 3 parallel jobs · Enterprise unlimited. Excess Generate clicks queue, never spawn duplicate jobs.

### FR-8 · Hosted Mock API
- FR-8.1 Temporary project-isolated URL exposing the selected HTTP methods as real CRUD endpoints.
- FR-8.2 **Seed data is always generated for readable endpoints** — a GET-only selection yields a read-only API pre-filled with mock records.
- FR-8.3 Requests are validated against the generated validation rules; invalid writes return structured errors.
- FR-8.4 Per-project rate limiting, request logging, and basic analytics.

### FR-9 · Expiration
- FR-9.1 Plan-based hosted-API lifetime: **Free 2 days · Pro 7 days · Enterprise 30 days**.
- FR-9.2 On expiry, a cleanup process **hard-deletes** hosted API config/URL, generated files, mock data, and temp caches.
- FR-9.3 The **project shell is kept**: name, original input, IPS, generation configuration, version history.
- FR-9.4 Expired project shows **Generate Again** → new job → new hosted API, no re-entry of anything.
- FR-9.5 Pre-expiry reminders (email + dashboard) with a prominent "Download ZIP" nudge.

### FR-10 · Artifact Registry, Regeneration & Versioning
- FR-10.1 Every artifact (IPS, JSON Schema, Zod, Yup, TypeScript, Mock Data, OpenAPI, Postman, Hosted API, Export Bundle) is tracked independently with: status (`pending · generating · completed · failed`), version, generated timestamp, worker ID, error message.
- FR-10.2 **Per-asset regeneration:** user can regenerate any subset (e.g., ☑ Zod only) without re-running everything.
- FR-10.3 **Every generation creates a version.** Users can view history and restore a previous version.

### FR-11 · Export
- FR-11.1 Download individual artifacts or a full ZIP bundle (schemas, validations, types, mock data, docs).

### FR-12 · Additional Outputs (V1 stretch — prioritized after FR-1–FR-11)
- Mongo Schema, Prisma, Drizzle, Supabase SQL; NestJS and Express scaffolds. All generated from the IPS like every other artifact; depth of these generators expands in V2/V3.

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Performance | Full generation of a typical project (≤ 5 entities) completes in well under the 3-minute budget; workers run in parallel |
| Scalability | Queue-based worker pool; workers stateless; horizontally scalable |
| Reliability | Per-worker retry with backoff; progress aggregator reflects true state |
| Security | AuthN/AuthZ on all project operations; strict input validation; hosted APIs isolated per project; rate limits + abuse prevention |
| Cost control | Expiry hard-delete keeps storage bounded; nesting depth cap prevents abuse |
| Observability | Job/worker status, durations, failure reasons logged and queryable |

## 7. Plans & Limits (single reference table)

| Plan | Hosted API lifetime | Concurrent generation jobs |
|---|---|---|
| Free | 2 days | 1 |
| Pro | 7 days | 3 |
| Enterprise | 30 days | Unlimited |

## 8. Release Scope

- **V1:** FR-1 → FR-11 as written above; FR-12 outputs as stretch.
- **V2:** entity relationships (references, FKs, 1-1/1-N/N-N), templates expansion, team features.
- **V3+/AI:** natural-language input, relationship detection, validation suggestions, Figma/OCR inputs, VS Code extension, CLI, desktop app.

## 9. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Abuse of hosted APIs (spam traffic, huge payloads) | Rate limits, payload size caps, nesting depth cap, per-project isolation |
| Storage growth | Plan-based expiry with hard delete of hosted assets |
| Generator output drift/bugs | All generators read only the IPS; golden-file tests per generator (see 15 · Testing) |
| Duplicate expensive jobs | Plan concurrency limits; idempotent job creation |
| User loses work at expiry | Project shell survives; reminders + Download ZIP before expiry; Generate Again after |

---

Next: [03 · User Flow →](./03-user-flow.md)

# 19 · Catalog Projects & Single APIs (Phase 8)

← [18 · AI Roadmap](./18-ai-roadmap.md) · [Master Index](./README.md)

This document reconciles `Mock_API_Platform_Documentation.md` (v1.0, the "Projects + Single APIs" catalog idea) with the engine that exists today. The source doc describes **what to ship**; this one describes **how it lands on the current architecture**, what it costs, and what must be decided before code is written.

---

## 1. Positioning: what the catalog actually is

The current product is a **compiler**: user input → IPS → generators → artifacts + an ephemeral hosted mock (doc 01 §2). The catalog doc describes a **library**: pre-built, relationally-consistent backend projects that a developer consumes without describing anything.

These are not competing products. The catalog is a **second front door onto the same pipeline**:

```
                        ┌─ user input (JSON / Swagger / builder)  ──┐
                        │                                           │
                        │                                           ▼
Catalog pack (data) ────┴──────────────────────────────────►  IPS  ──► Workers A–G ──► artifacts + hosted API
   student-erp, ecommerce, auth-api, invoice-api …                        (unchanged DAG)
```

**Rule for this phase: a catalog pack is *data*, never a hand-written backend.** Every pack compiles to an IPS and flows through the existing workers. If any pack needs a feature the engine lacks, the fix goes in the engine — never in the pack. This is the difference between a catalog that makes the whole platform better and a catalog that becomes six bespoke Express apps to maintain.

Consequence, and the reason this phase is worth doing: the catalog **forces the V2 features the roadmap already wants** (relations, real templates — doc 16 §V2) and pays for them with visible product value. Every user-generated project inherits relations, `?include=`, search/filter/sort, and hosted auth for free.

## 2. What the source doc silently assumes

The source doc is a good product brief and a dangerous engineering brief, because five of its bullet points are engine features that do not exist and are not on any roadmap:

| Source doc line | Reality in code today |
|---|---|
| "Database Relationships / `belongsTo`, `hasMany`" | The IPS has **no relation concept**. `Entity` is `{ name, fields }` and `FieldType` has no reference type — [`packages/ips/src/types.ts`](../packages/ips/src/types.ts). Relations are an explicit **V1 non-goal** (doc 02 §3) deferred to V2 (doc 16). |
| "`GET /students/1?include=attendance,marks`" | The runtime supports `page` and `limit` only — [`apps/mock-runtime/src/routes.ts`](../apps/mock-runtime/src/routes.ts). No include, no search, no sort, no field filters. |
| "JWT Authentication" (per project) | `packages/auth` authenticates **the platform**, not hosted mocks. The mock runtime has zero auth: every hosted route is public by design ([`server.ts`](../apps/mock-runtime/src/server.ts) reflects any CORS origin precisely because there are no credentials). |
| "Seed Data" with real foreign keys | `generateMockData` fills each entity independently with Faker and emits no `id` field at all; identity is invented at read time (`rec-<n>`) — [`mock-data.ts`](../packages/generators/mock-data/src/mock-data.ts), [`store.ts`](../apps/mock-runtime/src/store.ts). Referential integrity is impossible without an ordered, id-aware seeder. |
| "Business Rules", "Dashboard APIs", "Analytics APIs" | Nothing exists. And per doc 13 §4 the runtime **must never execute generated code**, so these have to be declarative data interpreted by a safe evaluator — the same posture as [`validate.ts`](../apps/mock-runtime/src/validate.ts). |
| "Role-based Access" | Not modelled anywhere in the hosting config. |

Two further mismatches the doc doesn't mention at all:

- **URL shape.** The doc writes `GET /students`. The runtime resolves `/p/:projectId/:entity` and 404s unless `projectId` is a 24-hex ObjectId ([`hosting.ts`](../apps/mock-runtime/src/hosting.ts)). A catalog needs stable, quotable, slug-based URLs (`/api/student-erp/students`).
- **Lifetime.** Hosted projects expire by plan and stop resolving (`status !== 'active'` → 404). "Build a complete frontend against this" implies a URL that works next month. `hosted.expiresAt = null` already means *never expires*, so the mechanism exists — but the **plan/quota model in doc 01 §7 assumes expiry is the upgrade lever**, and catalog projects opt out of it. That is a business decision, not a code change.

## 3. Decisions — **LOCKED**

Confirmed 2026-08-13. Two rules bind every phase below:

1. **A catalog pack is data, not a hand-written backend.** Packs compile to an IPS and flow through the existing generators/workers. Any gap a pack exposes is fixed in the engine, never in the pack.
2. **Student ERP is the first and only reference pack through Phases A–F.** It exercises relations, auth, roles, business rules, computed views, and realistic seeded data. Packs 2–6 follow as authoring work.

Sequence locked as **A → B → C → D → E → F → G** (§4), and §3.1 is settled as **per-consumer sandbox** (Phase D). The remaining subsections record the rationale.

### 3.1 Who owns the data behind a shared catalog project? — **decided: per-consumer sandbox (B)**

Six developers hit `DELETE /students/1` on the same Student ERP. What happens?

| Option | Behaviour | Cost |
|---|---|---|
| **A. Read-only demo** | Writes return `200` with a fabricated body but change nothing (the JSONPlaceholder model) | Trivial. Honest only if documented loudly; breaks "build a complete frontend" (no create-then-list flows) |
| **B. Per-consumer sandbox** ★ **chosen** | First write issues a sandbox key; reads merge a copy-on-write overlay over the shared seed; overlay TTLs after 24 h | ~1 phase of work (Phase D). Real writes, nobody can break the demo |
| **C. Clone-per-user** | "Use this project" copies the pack into the user's own Project row | Cheapest (the pipeline already does this), but requires signup and loses the zero-friction public URL that makes the catalog attractive to students |

Chosen: **B as the public surface, C as the logged-in surface.** They share everything except the store lookup: C is literally "run the existing generation pipeline from a pack", which Phase E delivers anyway.

### 3.2 Record identity format

The doc writes `/students/1`. Adopt **small stable integers for seeded catalog records** (`1..N`, per entity) so documentation examples are copy-pasteable, with UUIDs for records created at runtime. This requires `id` to become a real IPS field with an `identity` marker rather than a runtime fallback.

### 3.3 Response envelope

The doc shows no envelope. Keep the existing one — `{ data, meta: { page, limit, total } }` for collections, bare object for single records, and the `AppError` shape `{ error: { code, message, details } }` for failures. Catalog APIs must not invent a second convention.

### 3.4 Referential delete semantics

Deleting a `Classroom` that has `Students` must have one defined answer per relation. Recommended default `restrict` (`409 CONFLICT` listing blockers), with `cascade` and `setNull` selectable per relation in the pack.

### 3.5 Anonymous access

Catalog browsing and the hosted catalog APIs are **public, no signup**. Login is only needed to clone a pack into your own project (§3.1 option C). This contradicts nothing in the code but must be reflected in doc 13.

## 4. Gap analysis → build phases

Seven phases. **A is a hard prerequisite for everything else**; B and C are independent of each other once A lands.

### Phase A · IPS v2: relations *(size: L — the foundation)*

Add relations to the single source of truth and teach every generator to read them.

```ts
// packages/ips/src/types.ts
export type RelationKind = 'belongsTo' | 'hasOne' | 'hasMany' | 'manyToMany';

export interface Relation {
  /** Include key and JSON property name: ?include=classroom */
  name: string;
  kind: RelationKind;
  /** Target entity name, must exist in ips.entities */
  target: string;
  /** FK field on this entity (belongsTo/hasOne) — auto-materialised as a field */
  localField: string;
  /** Field on the target that localField points at (default the identity field) */
  foreignField: string;
  required: boolean;
  onDelete: 'restrict' | 'cascade' | 'setNull';
}

export interface Entity {
  name: string;
  fields: Field[];
  relations: Relation[];                                    // new
  identity: { field: string; style: 'int' | 'uuid' };       // new
}
```

Touches: `packages/ips` (types, validator, versioning) · `packages/generators/schema` (`$ref` + FK fields) · `validation` (zod/yup FK shape) · `types` (`classroomId: string` **and** `classroom?: Classroom`) · `mock-data` (§Phase A seeding) · `docs` (OpenAPI relation params, ER diagram) · `hosting` (relation map in the hosted config) · `packages/parsers` (unchanged — relations come from packs and the builder, not from inferred JSON).

Seeding becomes graph-ordered: topologically sort entities by `belongsTo`, seed parents first, and have children draw FK values from the parent ids that actually exist. Same deterministic-seed contract, so golden tests still work.

**Acceptance:** a two-entity pack with one `belongsTo` + one `hasMany` generates JSON Schema, TS types, Zod, OpenAPI 3.1, and mock data where **every FK value resolves to a real parent record**; IPS validator rejects dangling targets, unknown `localField`, and `manyToMany` without a join definition; existing golden tests updated, not bypassed.

### Phase B · Runtime query layer *(size: M)*

On `GET /{entity}` and `GET /{entity}/{id}`, in [`routes.ts`](../apps/mock-runtime/src/routes.ts):

| Param | Form | Notes |
|---|---|---|
| `page`, `limit` | exists | unchanged, still capped by `maxPaginationLimit` |
| `search` | `?search=John` | case-insensitive substring over pack-declared `searchable` fields |
| `sort` | `?sort=name`, `?sort=-createdAt` | whitelist; `-` prefix descends; multi-key comma list |
| filters | `?class=10&status=Active` | exact match on whitelisted fields |
| operators | `?fees_gte=1000&createdAt_lt=…` | suffixes `_gte _gt _lte _lt _ne _in` |
| `include` | `?include=attendance,marks,parent` | whitelisted relation names, **max depth 1 in V1**, per-request include count capped |

Unknown params are **422 with the allowed list**, not silently ignored — that is the difference between a teaching API and a toy. `include` resolution reads sibling entity stores through the same cached `readRecords`; cap expansion (e.g. 100 children per parent) so one request can't fan out unboundedly.

**Acceptance:** every query example in the source doc (§Pagination/Search/Sorting/Filtering/Include Relations) returns correct data against the Student ERP pack; unknown field in `sort`/`include` → 422; a `?include=` of a `hasMany` with 5 000 children stays bounded and inside the latency budget of doc 14.

### Phase C · Hosted auth & roles *(size: M)*

New per-project auth surface on the mock runtime:

```http
POST /api/{slug}/auth/register    POST /api/{slug}/auth/login
POST /api/{slug}/auth/refresh     POST /api/{slug}/auth/logout
GET  /api/{slug}/auth/me
```

- HS256 access + refresh tokens, reusing the `jose` helpers in `packages/auth` — but signed with a **per-project key derived (HKDF) from one server secret + projectId**, so no per-project secret is ever stored or shipped in an artifact bundle.
- Hosted config gains `requiresAuth: boolean` and `roles: string[]` **per entity per method**; the runtime returns `401` for missing/invalid tokens and `403` for role mismatch, both in the existing `AppError` envelope.
- Packs declare seeded demo users with roles; the project page must display the demo credentials, otherwise the API is undiscoverable.
- CORS: once tokens exist, `origin: true` is still correct (bearer tokens, not cookies) — do **not** switch to `credentials: true`.

**Acceptance:** the source doc's five auth endpoints work against a pack; a `student`-role token is 403'd on `DELETE /students/1` while `admin` succeeds; expired access token → 401 with a distinguishable code; no secret material appears in any generated artifact.

### Phase D · Sandbox isolation *(size: M — gates public launch)*

Implements §3.1 option B. `mockStores` gains an overlay dimension (`projectId` + `sandboxId`), reads merge overlay over base seed, writes only ever touch the overlay, overlays TTL out. Sandbox key arrives as `X-Sandbox-Key` (or is minted on first write and returned in a response header + documented).

**Also in this phase, and required regardless of §3.1:** the rate limiter currently keys on `projectId` ([`server.ts`](../apps/mock-runtime/src/server.ts)). For a shared catalog project that collapses every consumer on earth into **one global bucket** — the platform would rate-limit itself the day the catalog gets popular. Key on sandbox → API key → IP, and keep a separate, much higher per-project ceiling as the abuse backstop.

**Acceptance:** two sandbox keys against the same pack see independent writes and an unmodified base seed; no sandbox key → reads work, writes get a fresh key; overlay expiry restores the pristine seed; load from one consumer cannot 429 another.

### Phase E · Packs as data + catalog UI *(size: L)*

New `packages/catalog/` — one directory per pack, each default-exporting a typed object:

```ts
export interface CatalogPack {
  slug: string;                        // 'student-erp' → /api/student-erp/*
  kind: 'project' | 'single-api';
  title: string; tagline: string; category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  ips: Omit<InternalProjectSchema, 'projectId' | 'version'>;   // entities + relations + config
  auth?: { roles: string[]; users: SeededUser[] };             // Phase C
  seed: { recordsPerEntity: Record<string, number>; seed: number };
  queryable: Record<string, { searchable: string[]; sortable: string[]; filterable: string[] }>;
  rules?: BusinessRule[];              // Phase F
  views?: ComputedView[];              // Phase F
  overview: string;                    // markdown for the project page
}
```

API + UI: `GET /v1/catalog` (public, cached), `GET /v1/catalog/:slug`, `POST /v1/catalog/:slug/use` (clone into the caller's project → existing generation pipeline). Catalog browse + pack detail screens showing exactly what the source doc's "Project Page" section asks for: total APIs, total tables, ER diagram, relationship list, auth/dashboard/seed badges, and per-endpoint docs. The existing hard-coded `TEMPLATES` array in [`apps/web/src/app/templates/page.tsx`](../apps/web/src/app/templates/page.tsx) is replaced by this catalog, not kept alongside it.

ER diagram: emit `er-diagram.mmd` (Mermaid `erDiagram`) from the docs generator off the relation graph — no new runtime dependency, copy-pasteable, and the web app renders the same graph as a dependency-free SVG.

Per-endpoint documentation is **generated from the pack's OpenAPI 3.1 output**, never hand-written, so the source doc's "API Documentation Template" (endpoint, method, auth required, params, body, success/error responses, examples) is satisfied by extending the docs generator with security schemes + relation params rather than by writing prose per endpoint.

**Acceptance:** deleting a pack directory removes it from the catalog with no other code change; each pack has a golden test asserting its generated artifact set; the project page's "total APIs / total tables" numbers are computed from the IPS, not typed by hand.

### Phase F · Business rules & computed endpoints *(size: M)*

Both declarative, both interpreted by the safe evaluator — no `eval`, no generated code execution (doc 13 §4).

```ts
type BusinessRule = {
  on: `${string}.${'create' | 'update' | 'delete'}`;   // 'Attendance.create'
  when: Condition;                                     // supports relation paths: 'student.status'
  reject: { status: number; code: string; message: string };
};

type ComputedView = {
  path: string;                                        // 'dashboard' → GET /api/{slug}/dashboard
  requiresAuth?: boolean; roles?: string[];
  metrics: Array<
    | { key: string; op: 'count'; entity: string; where?: Condition }
    | { key: string; op: 'sum' | 'avg' | 'min' | 'max'; entity: string; field: string; where?: Condition }
    | { key: string; op: 'groupBy'; entity: string; by: string; agg: 'count' | 'sum'; field?: string }
    | { key: string; op: 'recent'; entity: string; sort: string; limit: number }
  >;
};
```

**Acceptance:** a rule blocking attendance for an inactive student returns 422 with a stable code and does not corrupt the store; `GET /dashboard` returns every metric the Student ERP pack declares; both are covered by pack golden tests; a malformed rule fails **pack validation at build time**, not at request time.

### Phase G · Single APIs (behavioural packs) *(size: M–L)*

The doc's second category is not CRUD. Authentication, Invoice, Payment, Chat, and Weather need a `kind: 'single-api'` pack with **scripted endpoints**: state machines (invoice `draft → sent → paid → overdue`, payment `pending → succeeded/failed` plus a simulated webhook), deterministic pseudo-random responses (weather keyed by `city + date` so the same request always answers the same), and stateful sub-resources (chat rooms/messages). Design this phase only after A–D are real; roughly half of these packs collapse into plain CRUD + Phase F rules once relations exist, and that's the cheap path to take where it works.

## 5. Sequencing (and where the source doc's roadmap goes wrong)

The source doc's roadmap is content-first: "Phase 1 — Student ERP + Auth/Product/Invoice APIs." Building content before the engine guarantees Student ERP gets hand-coded and permanently diverges from the pipeline.

Correct order — **one pack drives the engine, then packs get cheap**:

```
A (relations) ──► B (query layer) ──┬──► E (Student ERP pack + catalog UI) ──► F (rules/dashboard) ──► G (single APIs)
                  C (hosted auth) ──┘
                  D (sandbox + rate-limit key)  ← must land before any public catalog URL is advertised
```

Build **Student ERP only** through A–F. It is the doc's own example and it exercises every hard case: `belongsTo`, `hasMany`, roles, a dashboard, and a business rule. Packs 2–6 (E-Commerce, HRMS, CRM, Hospital, Banking) are then authoring work, not engineering work — which is the whole point of the pack-as-data rule. If pack 2 needs engine changes, that is the signal Phase A's model is wrong.

## 6. Existing docs this phase invalidates

This phase is a **product pivot**, not an addition, and the plan docs must say so:

- **doc 02 §3 Non-Goals** — "Entity relationships / foreign keys — V2" must be struck; relations become Phase 8 scope.
- **doc 16 Roadmap** — V2's "Entity relationships" and "Template expansion" are exactly Phases A and E; fold them in rather than leaving two competing plans. V2's "hosted-API auth/RBAC hardening comes after team features" ordering is now reversed (Phase C precedes teams).
- **doc 07 Database Design** — `mockStores` gains the sandbox dimension; a `catalogInstances` (or reserved `Project`) concept for non-expiring catalog projects.
- **doc 08 API Design** — the query-parameter contract of Phase B, the slug URL scheme, and the hosted auth routes.
- **doc 13 Security** — public/anonymous catalog access, per-project token derivation, the rate-limit key change, and an explicit note that rules/views stay interpreted.
- **doc 14 Performance** — `include` fan-out and dashboard aggregation are the first hosted operations whose cost is not O(page size).

## 7. Top risks

1. **Hand-writing pack backends.** The failure mode that kills the whole idea. Enforce pack-as-data with golden tests per pack.
2. **Shared mutable demo data** (§3.1) — one `DELETE` ruins the catalog for everyone. Phase D gates public launch.
3. **Rate-limit key collapse** — a real, already-present bug the moment a project is shared widely. Cheap to fix now.
4. **Relation model churn.** Getting `Relation` wrong means re-touching seven generators. Prototype Phase A against Student ERP *and* one of E-Commerce (`manyToMany` order↔product) before locking the type.
5. **Unbounded expansion** — `?include=` plus dashboard aggregates are the first way a single request can cost seconds. Cap in Phase B/F, not after launch.
6. **The free-forever tension** — catalog URLs that never expire remove the upgrade lever doc 01 §7 relies on. Decide the quota story (per-sandbox request caps? auth required above N req/day?) before launch, not after.

---

← [18 · AI Roadmap](./18-ai-roadmap.md) · [Master Index](./README.md)

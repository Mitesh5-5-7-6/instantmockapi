# 16 · Roadmap

← [15 · Testing](./15-testing.md) · [Master Index](./README.md) · Next: [17 · Coding Standard](./17-coding-standard.md)

Sequenced by capability, not calendar dates. Each version builds on the same invariant: **one Internal Project Schema, everything generated from it.** AI-specific work has its own detail in [18 · AI Roadmap](./18-ai-roadmap.md).

---

## V1 — Core Generation Platform (the current scope)

The complete generate-review-host loop for a single developer.

**Inputs**
- Paste JSON, Manual Schema Builder (unlimited nesting, dynamic arrays, Layer 1 + Layer 2 validation), Swagger/OpenAPI import.

**Generation (Workers A–G)**
- A JSON Schema · B Zod + Yup · C TypeScript · D Mock Data · E OpenAPI + Postman · F Hosted Mock API · G Export ZIP.
- Selective generation driven by `generationConfig` (validators, types, methods, record count).

**Runtime & lifecycle**
- Hosted mock CRUD API with per-project isolation, seed data, rate limiting, logging.
- Plan-based expiry: **Free 2 days · Pro 7 days · Enterprise 30 days**; hard-delete hosted assets, keep project shell → one-click **Generate Again**.
- Concurrency: **Free 1 · Pro 3 · Enterprise ∞**.

**Platform foundations**
- Artifact Registry (independent per-artifact status/version/worker/error).
- Per-worker retry, per-asset regeneration, versioning with restore.
- Async job pipeline (queue + workers), live SSE progress, review-before-generate.

**Stretch within V1** (prioritized after A–G, doc 02 FR-12): additional schema/ORM/server targets — Mongo Schema, Prisma, Drizzle, Supabase SQL, NestJS, Express.

## V2 — Relationships, Templates, Teams

Depth on the model and the first multi-user step.

- **Entity relationships:** references / foreign keys and **1-1, 1-N, N-N** in the IPS and every generator (schemas, validations, types, mock data honoring relations, docs, hosted API with related routes). Reserved IPS keys from V1 are filled in here (doc 04, §F3).
- **Additional validators:** Joi and Valibot outputs (deferred from V1) added to Worker B.
- **Template expansion:** a real starter gallery (CRM, e-commerce, blog, auth, SaaS) that pre-loads a complete IPS + config, beyond V1's light templates.
- **Team collaboration (phase 1):** shared projects, membership, and basic roles — introduces RBAC groundwork flagged in doc 13, §10.
- **Deeper stretch generators:** mature the V1 stretch targets (fuller Prisma/Drizzle/NestJS/Express output).

## V3 — Intelligence & Reach

InstantMockAPI becomes proactive and portable. Full detail in [18 · AI Roadmap](./18-ai-roadmap.md).

- **AI requirement understanding:** natural-language description → IPS draft, plugged in as another parser adapter (pipeline unchanged).
- **AI relationship detection:** infer relations between entities to bootstrap V2's relationship model.
- **AI validation suggestions:** propose Layer 2 rules from field semantics.
- **AI backend assistant:** answer "what does this endpoint expect?" from the IPS.
- **New input modes:** **Figma import**, **screenshot / OCR**, **PDF requirements** — each becomes a valid input source producing an IPS draft.
- **Reach:** **VS Code extension**, **CLI**, and **desktop app** — the IPS becomes a portable artifact developers carry between tools.

## Cross-Version Principles

| Principle | Held across all versions |
|---|---|
| Single source of truth | Every new input is just another way to produce an IPS; every new output just another generator reading it |
| Additive, not breaking | New generators/inputs slot into the existing pipeline (doc 09) and worker DAG (doc 10) without reshaping the core |
| Selective & synchronized | More outputs never mean generating everything blindly; all outputs stay in sync by construction |
| Ephemeral hosting | Plan-based expiry + hard delete remains the cost-control and upgrade lever at every tier |

## Dependency Notes

- V2 relationships are a **prerequisite** for the most useful AI relationship detection and for related hosted routes.
- AI inputs (V3) depend only on the parser-adapter seam already defined in V1 (doc 06, §11; doc 09, §2), so they don't require reworking generation.
- Team features (V2) precede any hosted-API auth/RBAC hardening (doc 13, §10).

---

Next: [17 · Coding Standard →](./17-coding-standard.md)

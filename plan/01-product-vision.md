# 01 · Product Vision

← [Master Index](./README.md) · Next: [02 · PRD](./02-prd.md)

---

## 1. Why This Project Exists

Every frontend project begins with the same bottleneck: **the backend isn't ready yet.**

Before a frontend developer can build a single screen against real-shaped data, someone must hand-write a JSON Schema, a Zod or Yup validation, TypeScript types, CRUD endpoints for testing, mock/seed data, and OpenAPI/Postman documentation. Every one of those artifacts describes the **same data model** — yet each is written separately, by hand, in a different syntax. They drift out of sync the moment the model changes.

InstantMockAPI exists to collapse that entire ritual into one step: describe your data once, and receive every backend artifact — plus a live, hosted mock API — in under three minutes.

## 2. What InstantMockAPI Is (and Is Not)

**InstantMockAPI is a Backend Generation Platform.**

It analyzes developer input, builds an Internal Project Schema (IPS), generates every backend asset from that single model in parallel, and optionally hosts a temporary Mock REST API.

**InstantMockAPI is not:**

- ❌ A database service (Supabase, Firebase) — it stores no production data
- ❌ An API gateway or production hosting platform
- ❌ A code editor or IDE

Think of it as a **compiler for backend requirements**: inputs are the frontends, the IPS is the intermediate representation, and each generator is a compilation target.

## 3. Target Audience

| Audience | Pain today | What InstantMockAPI gives them |
|---|---|---|
| **Frontend developers** (primary) | Blocked waiting for backend; hand-writes mocks and types | A hosted CRUD API + types + validations in minutes |
| **Full-stack developers & freelancers** | Rewrites the same boilerplate on every project | Prisma/Mongo/Drizzle schemas, NestJS/Express scaffolds, docs — generated |
| **Small teams & agencies** | No dedicated backend engineer early in a project | A complete development-ready backend environment on day one |
| **Backend developers** | Tedious sync between schema, validation, types, docs | One source of truth; regenerate any asset on change |

## 4. Current Market Problems

1. **Repetition** — the same model gets hand-encoded 6–8 times (schema, validation, types, mocks, docs, endpoints).
2. **Drift** — hand-written artifacts silently fall out of sync; docs lie, types mismatch, mocks go stale.
3. **Blocked frontends** — UI work stalls until *some* API exists; teams burn time on throwaway Express servers.
4. **Tool fragmentation** — one tool for mocking, another for types, another for docs; nothing shares a model.

## 5. Why Existing Solutions Are Incomplete

| Existing approach | What it solves | What it misses |
|---|---|---|
| JSON mock servers (json-server, Mockoon) | Quick fake endpoints | No validations, no types, no docs, no schema outputs |
| Type generators (quicktype) | Types from JSON | No API, no validation, no mock data, no docs |
| API design tools (Stoplight, Postman) | Documentation-first design | No generated validations/types/ORM schemas; mock servers are shallow |
| BaaS (Supabase, Firebase) | Real hosted backend | Heavyweight; couples you to their runtime; not a *toolkit generator* |
| Copilots / AI snippets | Speed up typing each artifact | Still N separate artifacts with no shared source of truth |

Each tool solves one output. **None of them generate everything from one model and keep it synchronized.** That synchronization — the single source of truth — is InstantMockAPI's defensible core.

## 6. Product Philosophy

> **Write Requirements Once. Generate Everything. Review Once. Deploy Instantly.**

Principles that follow from it:

1. **One model, many targets.** Every generator reads only the IPS. No generator ever re-parses raw input.
2. **Selective generation.** The user chooses outputs (validators, types, HTTP methods); we never generate blindly.
3. **Review before compute.** The user confirms the parsed model on a Review screen before any job runs — trust first, generation second.
4. **Generation feels alive.** Parallel workers with live per-asset progress, never a silent spinner.
5. **Failure is partial, never total.** Workers are independent; one failed asset means one Retry button, not a failed project.
6. **Ephemeral by design.** Hosted mock APIs expire on plan-based schedules; the project shell survives so regeneration is one click.

## 7. Business Model

Freemium SaaS. The primary upgrade pressure comes from two natural levers — **hosted API lifetime** and **generation concurrency**.

| Plan | Hosted API lifetime | Concurrent jobs | Intended user |
|---|---|---|---|
| **Free** | 2 days | 1 active generation | Trying it out, hackathons, quick prototypes |
| **Pro** | 7 days | 3 parallel jobs | Freelancers, active projects |
| **Enterprise** | 30 days | Unlimited | Teams, agencies, long-running programs |

On expiry, hosted assets are hard-deleted (storage costs stay near zero) while the project shell is kept — so an expired Free project is a *conversion moment*: upgrade for a longer-lived API, or click "Generate Again."

## 8. Long-Term Vision

InstantMockAPI grows from a generation tool into a **backend intelligence layer**:

- **Near term (V1–V2):** more targets (Prisma, Drizzle, NestJS, Express deepening), templates, entity relationships (1-1, 1-N, N-N), team features.
- **AI era (V3+):** natural-language requirement understanding, automatic relationship detection, validation suggestions, and an AI backend assistant that answers "what does this API expect?" from the IPS.
- **Everywhere:** VS Code extension, CLI, desktop app — the IPS becomes a portable artifact developers carry between tools.
- **New inputs:** Figma designs, screenshots (OCR), PDF requirements — anything that describes data becomes a valid input source.

The constant across all of it: **one internal model, everything generated from it, always in sync.**

---

Next: [02 · Product Requirements Document →](./02-prd.md)

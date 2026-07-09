# 09 · Generator Engine

← [08 · API Design](./08-api-design.md) · [Master Index](./README.md) · Next: [10 · Worker Engine](./10-worker-engine.md)

The generator engine is the **compiler core**: input formats are front-ends, the IPS is the intermediate representation, and each generator is a back-end target. This document covers the *transformations*; [10 · Worker Engine](./10-worker-engine.md) covers how they're *scheduled and run*.

---

## 1. Pipeline

```
Input (JSON | Swagger | Builder | Docs)
        │
        ▼
   Parser adapter ────────────────► parse error (path-pointed) → surfaced in Review
        │
        ▼
   Internal Project Schema (IPS)  ← the single source of truth (doc 04 §F3)
        │
   User Review (edit/confirm)
        │
   generationConfig (validators, types, methods, mockRecords)
        │
        ▼
   Generation Job  →  Queue  →  Workers A–G  (doc 10)
        │
        ▼
   Artifacts written to Registry + object storage
```

**Invariant:** every generator receives `(IPS, generationConfig)` and nothing else. No generator re-parses raw input; no generator reads another generator's output — with the two explicit, IPS-mediated exceptions noted in §4 (docs and hosting consume *mock data records*, which are themselves derived from the IPS).

## 2. Parser Adapters (input → IPS)

| Adapter | Input | Notes |
|---|---|---|
| `json-adapter` | Sample JSON payload | Infers field types; ISO strings → `date`; key-name heuristics → email/phone/url **suggestions** (Layer 1), user-confirmable |
| `swagger-adapter` | OpenAPI/Swagger file | Maps schemas/components to IPS entities + fields + rules |
| `builder-adapter` | Manual Schema Builder | Edits the IPS **directly** — the builder is a UI over the IPS, so this "adapter" is largely identity |
| `docs-adapter` | Existing API docs | Best-effort extraction; ambiguous fields flagged for Review |

Output is always a **valid IPS** or a structured error pointing at the offending path (e.g., `addresses[0].location.city`). Adapters are the *only* code allowed to touch source formats (doc 05, §4).

## 3. The IPS as Contract

Recap (full shape in doc 04, §F3): entities → fields → `{ type, required, default, children[], validation, meta }`. `children` recursion yields **unlimited nesting** with a configurable depth cap (default 10). Validation merges **Layer 1 (auto-detected)** + **Layer 2 (user custom)** *before* generation, so every generator translates one already-merged rule set — it never re-detects formats.

## 4. Generators (IPS → artifact)

Each maps to a worker (doc 10). All are **pure functions**: same input ⇒ byte-identical output (enables golden-file tests, doc 15).

### Worker A — Schema Generator → **JSON Schema**
- Emits JSON Schema mirroring IPS structure; nested objects/arrays become nested `properties`/`items`.
- Enabled via the **Advanced** option in the question flow.

### Worker B — Validation Generator → **Zod, Yup**
- Translates the merged validation rules into each selected validator.
- Rule coverage: Required, Nullable, Optional, Default, Min, Max, Length, Regex, Enum, Email, URL, UUID, Date, Number/Decimal/Integer, Array Length, Unique (as metadata/comment where unsupported natively), Custom messages.
- Nested structures produce nested schemas (`z.object`, `z.array(z.object(...))`) matching the IPS exactly.
- **V1 targets only Zod + Yup** — Joi/Valibot deferred.

### Worker C — Type Generator → **TypeScript**
- One interface per entity; nested structures become named sub-interfaces (`CustomerAddressLocation`) for readability.
- `required` → optionality; `enum` → union types; `date` → `string` (ISO) with a comment, matching the wire format the mock API returns.

### Worker D — Mock Data Generator → **records / seed / examples**
- Faker-style values honoring type + constraints (min/max/length/regex/enum; valid emails for email fields, etc.).
- Default 25 records/entity (configurable). Produces: hosted-API **seed data**, downloadable **JSON**, and **example responses** consumed by docs.
- **Always runs when hosting runs**, and also runs standalone (mock data is a core artifact).

### Worker E — Documentation Generator → **OpenAPI, Postman**
- Builds an OpenAPI spec + Postman collection from IPS + `generationConfig`.
- **Only selected methods** are documented; example bodies come from **Worker D's example responses**, so docs and the live API always agree.

### Worker F — Hosting Generator → **mock-runtime config**
- Produces the routing/config the mock runtime serves (entities, selected methods, validation rules, seed store reference).
- Consumes Worker D's seed data as the initial `mockStores` content (doc 07).

### Worker G — Export Generator → **ZIP bundle**
- Bundles all produced artifacts + a `README` noting the IPS version; also supports single-artifact downloads.

### Stretch generators
- Mongo Schema, Prisma, Drizzle, Supabase SQL, NestJS, Express — same pure `(IPS, config) → files` contract; prioritized after A–G (doc 02, FR-12).

## 5. Selective Generation

`generationConfig` decides which generators run:

```
validators: ["zod","yup"]        → Worker B emits zod + yup only (not joi/valibot)
validators includes "jsonschema" → Worker A runs
types: ["typescript"]            → Worker C runs (else skipped)
methods: non-empty               → Worker F (hosting) + Worker D (seed) run
methods: empty                   → Worker F skipped; Worker D still runs (core artifact)
any downloadable produced        → Worker G bundles it
```

This is why the engine never "generates everything blindly" — the config is the switchboard (doc 03, §3 decision tree).

## 6. Dependency Order (data, not just sequence)

```
IPS ──► A (JSON Schema)          ┐
IPS ──► B (Zod/Yup)              │ independent — run in parallel
IPS ──► C (TypeScript)           │
IPS ──► D (Mock Data) ──┐        ┘
                        ├──► E (Docs — needs D's examples)
                        └──► F (Hosting — needs D's seed)
A,B,C,D,E,F produced ──► G (Export — bundles what exists)
```

A/B/C/D start immediately; E and F wait on D; G waits on everything selected. The Worker Engine (doc 10) enforces this DAG.

## 7. Regeneration & Versioning Hooks

- **Per-asset regeneration** re-runs only the selected generators; each writes a new artifact version to the Registry (doc 07, `artifacts.version`).
- Because generators are pure and IPS-versioned, regenerating one artifact can never desync it from the model — it's produced from the same IPS snapshot the version points to.
- Editing the IPS in Review + generating produces a new `versions` snapshot; generators run against that snapshot.

## 8. Error Handling in the Engine

- **Parse-time:** structured error with the offending IPS path → shown in Review; no job is created.
- **Generate-time:** a generator failure marks *that* artifact `failed` with `errorMessage` in the Registry; dependents wait; the user retries **only** the failed worker (doc 10, §Retry). The engine never aborts sibling artifacts.

## 9. Why This Design Holds

1. **One IR (the IPS)** → N targets stay synchronized by construction.
2. **Pure generators** → deterministic, testable, cache-friendly, safe to parallelize.
3. **Config-driven** → selective, cheap, matches exactly what the user asked for.
4. **DAG-ordered** → docs/hosting always reflect real mock data; exports always reflect real artifacts.

---

Next: [10 · Worker Engine →](./10-worker-engine.md)

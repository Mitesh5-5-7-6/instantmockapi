# 04 · Feature Specification

← [03 · User Flow](./03-user-flow.md) · [Master Index](./README.md) · Next: [05 · Monorepo Architecture](./05-monorepo-architecture.md)

Each feature below maps to a functional requirement in [02 · PRD](./02-prd.md) and, where applicable, to a worker (A–G).

---

## F1 · Project Management (FR-1)

**What:** CRUD for projects plus lifecycle state.

- States: `draft → generating → active → expired` (user delete possible from any state).
- Dashboard card data: name, entity count, state, plan badge, expiration countdown (`expiresAt - now`, live tick), last generated timestamp.
- Actions per state: draft → Continue setup · generating → View progress · active → Open / Download / Regenerate · expired → **Generate Again**.

**Acceptance:** countdown accurate to the minute; state transitions driven by job/cleanup events, never by the client.

## F2 · Requirement Parser (FR-2)

**What:** Converts any input source into the Internal Project Schema (IPS).

- Input adapters (V1): `json-adapter`, `swagger-adapter`, `builder-adapter` (the Manual Builder edits IPS directly), `docs-adapter` (existing API documentation, best-effort).
- JSON inference rules: value type → field type; ISO strings → date; key-name heuristics → email / phone / url format hints (surfaced as **Layer 1 suggestions**, user-confirmable in Review).
- Parser output is always a valid IPS or a structured parse error pointing at the offending path (`addresses[0].location.city`).

**Rule:** no generator ever reads raw input — adapters are the only code that touches source formats.

## F3 · Internal Project Schema — IPS (FR-2.2)

**What:** The single source of truth. Simplified shape:

```jsonc
{
  "projectId": "…",
  "version": 3,
  "entities": [
    {
      "name": "Customer",
      "fields": [
        {
          "name": "email",
          "type": "email",            // string|number|decimal|integer|boolean|date|email|url|uuid|enum|object|array
          "required": true,
          "default": null,
          "children": [],              // for object / array-of-object types — recursive
          "validation": {              // Layer 1 (auto) + Layer 2 (custom), merged
            "email": true,
            "min": 3, "max": 100,
            "regex": null, "enum": null,
            "message": "Enter a valid email"
          },
          "meta": { "unique": true }
        }
      ]
    }
  ],
  "generationConfig": {
    "validators": ["zod", "yup"],     // + "jsonschema" via Advanced
    "types": ["typescript"],
    "methods": ["GET", "POST"],
    "mockRecords": 25
  }
}
```

- `children` recursion gives **unlimited nesting**; a configurable depth cap (default 10) rejects abusive structures with a clear error.
- Entity relationships (refs/FKs) are intentionally absent — reserved keys planned for V2.

## F4 · Manual Schema Builder (FR-3)

**What:** Visual editor over the IPS.

- Entity list + per-entity dynamic field rows: name, type dropdown, required toggle, default value.
- `object` / `array` types expand into indented child groups with their own "Add Field"; arrays of objects supported at any level; "Add Another" models dynamic arrays.
- Per-field **validation popover** (Layer 2): min, max, length, regex, enum values, custom message, nullable/optional/default, unique (metadata).
- Live Layer-1 hint chips: naming a field `email` suggests email validation inline (accept/dismiss).

**Acceptance:** the demo Customer schema (primaryDetail{}, addresses[]→location{}, education[]→college{}→address{}) — 4 levels deep — builds without friction.

## F5 · Schema & Validation Generators (FR-4 · Workers A + B)

**What:** Emits schema and validator code from IPS validation config.

- **Worker A — JSON Schema** (enabled via the "Advanced" checkbox in the question flow).
- **Worker B — Zod, Yup** (the V1 validator checkboxes). Joi/Valibot deferred.
- Layer 1 + Layer 2 rules merge in the IPS *before* generation — generators translate one merged rule set, they never re-detect.
- Supported rules: Required, Nullable, Optional, Default, Min, Max, Length, Regex, Enum, Email, URL, UUID, Date, Number, Decimal, Integer, Array Length, Unique (emitted as metadata/comment where the target has no native support), Custom messages.
- Nested objects/arrays produce nested schemas (e.g., `z.object` / `z.array(z.object(...))`) mirroring IPS structure exactly.

## F6 · Type Generator (FR-5.2 · Worker C)

**What:** TypeScript interfaces + DTOs from the IPS.

- One interface per entity; nested structures become named sub-interfaces (`CustomerAddressLocation`) to stay readable.
- Optionality follows `required`; `enum` becomes union types; `date` → `string` (ISO) with a comment, matching the mock API's wire format.

## F7 · Mock Data Generator (FR-8.2 · Worker D)

**What:** Faker-style records matching field types and validation constraints.

- Respects min/max/length/regex/enum where feasible; email fields get valid emails, etc.
- Default 25 records per entity (user-configurable in the question flow).
- Outputs: seed files for the hosted API + downloadable JSON + example responses used by docs.
- **Rule:** every readable endpoint must have seed data — Worker D always runs when Worker F runs, and also runs standalone since mock data is a core downloadable artifact.

## F8 · Hosted Mock API (FR-8 · Worker F)

**What:** Temporary, project-isolated CRUD REST API.

- URL scheme: `https://api.InstantMockAPI.dev/p/{projectId}/{entity}` (+ `/{id}` for item routes).
- Only user-selected methods are routed; others return `405`.
- Writes validated against generated rules → `422` with field-level errors on failure.
- GET supports pagination (`?page&limit`) over seed data; writes mutate the project's isolated mock store.
- Per-project rate limiting, request log, basic analytics (counts per method/endpoint).
- Lifetime = plan expiry (see F11).

## F9 · Documentation Generator (Worker E)

**What:** OpenAPI spec, Swagger UI-compatible output, Postman collection — all derived from IPS + generationConfig.

- Only selected methods are documented; example bodies come from Worker D's example responses so docs and API always agree.

## F10 · Export Engine (FR-11 · Worker G)

**What:** Downloadables — per-artifact files and a full ZIP bundle (schemas, validations, types, mock data, docs, scaffolds when generated).

- ZIP layout mirrors artifact names; includes a `README` describing contents and the IPS version they came from.

## F11 · Expiration System (FR-9)

**What:** Plan-based lifetime with hard delete of hosted assets and a surviving project shell.

| Plan | Lifetime |
|---|---|
| Free | 2 days |
| Pro | 7 days |
| Enterprise | 30 days |

- Scheduled cleanup worker: hard-deletes hosted API route/config, generated files in storage, mock data, temp caches → flips project state to `expired`.
- **Kept:** name, input, IPS, generation config, version history.
- Reminders before expiry (email + dashboard) with Download ZIP nudge.
- **Generate Again:** creates a fresh Generation Job from the kept IPS + config — one click, new hosted URL.

## F12 · Artifact Registry (FR-10.1)

**What:** First-class tracking of every artifact, independently.

```
Artifact record:
  projectId · artifactType · version
  status: pending | generating | completed | failed
  generatedAt · workerId · errorMessage · storageRef
```

- Powers the Progress board, the Project-page artifact grid, per-worker Retry, per-asset Regenerate, and version history.
- Registry is the *only* source the UI reads artifact state from — workers write to it, UI subscribes.

## F13 · Per-Worker Retry & Per-Asset Regeneration (FR-7.3, FR-10.2)

- **Retry:** re-enqueues only the failed worker with the same job context; completed artifacts untouched; downstream dependents resume when the dependency completes.
- **Regenerate:** user-selected subset of artifacts → mini-job enqueuing only those workers; each regenerated artifact gets a new version entry in the registry.

## F14 · Versioning (FR-10.3)

- Every generation (full or partial) stamps affected artifacts with a new version tied to the IPS version used.
- Version history panel lists versions with timestamps; **Restore** reverts IPS + config to that version's snapshot (next generation builds from it).

## F15 · Dashboard, Templates, Settings, Billing

- **Dashboard:** F1's card grid + plan indicator + usage (active jobs vs. plan limit).
- **Templates:** pre-built IPS starters (e.g., CRM, E-commerce, Blog) — thin V1, expands in V2.
- **Settings:** profile, theme, notification prefs.
- **Billing:** plan comparison (lifetimes + concurrency), upgrade/downgrade.

## F16 · Concurrency Guard (FR-7.4)

- Job creation checks active-job count against plan limit (Free 1 / Pro 3 / Enterprise ∞); excess requests enter a visible queued state.
- Idempotency key per (project, IPS version, config hash) prevents duplicate jobs from rapid clicks.

---

Next: [05 · Monorepo Architecture →](./05-monorepo-architecture.md)

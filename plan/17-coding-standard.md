# 17 · Coding Standard

← [16 · Roadmap](./16-roadmap.md) · [Master Index](./README.md) · Next: [18 · AI Roadmap](./18-ai-roadmap.md)

These rules make the monorepo (doc 05) enforceable and the generator engine (doc 09) safe to extend. Where a rule is lint- or CI-enforced, it's marked **[enforced]**.

---

## 1. Naming

| Thing | Convention | Example |
|---|---|---|
| Packages | kebab-case | `mock-data`, `packages/registry` |
| Directories | kebab-case | `features/review/` |
| Types / interfaces / classes | PascalCase | `InternalProjectSchema`, `ArtifactRecord` |
| Functions / variables | camelCase | `generateZod`, `ipsSnapshot` |
| Constants / enums values | UPPER_SNAKE where truly constant | `MAX_NESTING_DEPTH` |
| Artifact/worker identifiers | match the domain vocabulary | `artifactType: "json_schema"`, `worker: "B"` |
| React components | PascalCase files | `StatusChip.tsx`, `SchemaTree.tsx` |

- **Generator packages are named after their output**, one per folder: `generators/schema`, `generators/validation`, `generators/types`, … (doc 05, §2). No generator folder produces two artifact types.
- Name things by what the user controls in UI copy (doc 11 voice), and by the domain in code — keep both vocabularies consistent (`Generate`, `Regenerate`, `Generate Again` mean the same things in UI, API, and code).

## 2. Folder Rules

- **Feature-first inside apps:** `apps/web/src/features/{dashboard,input,configure,review,progress,project,settings}/…` — screens map to features (doc 11). Co-locate a feature's components, hooks, and tests.
- **No `utils` dumping ground [enforced].** Shared helpers go to `packages/shared` with tests; app-local helpers live beside their feature. A catch-all `utils/` folder is rejected in review.
- **Generators, parsers, registry, queue, db, config, ui, shared** are separate packages with single responsibilities (doc 05, §3). Business logic never lives in `queue`, `db`, or `ui`.

## 3. Architecture Rules **[enforced]**

The dependency graph (doc 05, §4) is enforced by **dependency-cruiser** in CI; violations fail the build.

1. **Dependencies point downward only; no cycles.** No package imports an app.
2. **Generators are pure:** `(IPS, generationConfig) → artifact content`. **No I/O** — no DB, network, filesystem, env, or clock inside a generator (seed/time are passed in). This is what makes them testable, cacheable, parallelizable, and low-blast-radius (doc 13, §8).
3. **Only `apps/api` creates jobs; only `apps/workers` executes them; only `packages/registry` mutates artifact status.** No other component changes job/artifact state.
4. **`apps/web` talks to the backend over HTTP only** — it never imports `db`, `generators`, `queue`, or `registry`.
5. **The IPS is the sole contract between parsing and generation.** No generator reads raw input; parsers are the only code touching source formats.
6. **Plan limits and config come from `packages/config`** — never hard-coded inline (the "Free = 2 days / 1 job" values live in exactly one place, doc 05, §5).

## 4. TypeScript Rules

- **Strict mode on** across all packages [enforced]; no implicit `any`.
- Shared types (IPS, config, artifact records, API DTOs) are **exported from their owning package** and imported — never re-declared. One IPS change should surface every affected site at compile time (doc 05, §5).
- Prefer discriminated unions for states (`status`, `job.type`) so exhaustiveness is compiler-checked (mirrors the registry state machine, doc 15).
- No `// @ts-ignore` without an inline justification comment.

## 5. Error Handling

- Return **structured errors** with a machine code + human message (doc 08, §7); never throw raw strings across boundaries.
- Parse/validation errors carry the **offending path** (`addresses[0].location.city`).
- Generator failures surface via the Registry (`failed` + `errorMessage`), not by aborting sibling work (doc 10, §7).
- User-facing copy is interface-voice and actionable, never a stack trace (doc 11, §11).

## 6. Testing Rules **[enforced in CI]**

(Full strategy in doc 15.)
1. Every generator ships **golden-file tests**; no generator merges without them.
2. Every parser ships fixture suites covering success **and** structured errors.
3. Mock-data tests are **deterministic** (fixed seed).
4. Registry transition tests are **exhaustive**.
5. New API endpoints require **contract tests**; hosted-API changes require **isolation + validation** tests.
6. E2E (Playwright) tests are **real and executable — never pseudo-code**; the happy-path E2E runs on every PR.

## 7. Commit & PR Rules

- **Conventional Commits [enforced]:** `feat(generators/zod): support enum messages`, `fix(mock-runtime): cap list limit`, `docs(readme): update index`. Scope names match package/app names.
- **One package/app per PR where feasible** — keeps the dependency graph and reviews clean.
- PRs must pass **affected `lint · typecheck · test · build`** and the **dependency-cruiser** graph check before merge (doc 15, §7).
- No merge with a red graph check, failing tests, or type errors.
- PR description states which docs (this set) the change affects when it alters documented behavior.

## 8. Formatting & Linting

- **ESLint + Prettier** shared configs in `tooling/`, applied uniformly [enforced].
- Import ordering and boundary rules are lint-enforced (the boundary rules double as the architecture guard, §3).
- No dead code, no commented-out blocks in merges.

## 9. Consistency With the Docs

The vocabulary in code must match this documentation set:
- Statuses exactly: `pending · generating · completed · failed · active · expired` (doc 12).
- Worker IDs A–G with their fixed outputs (doc 09/10).
- Plan values 2/7/30 days and 1/3/∞ jobs, sourced from `packages/config`.
- Artifact types exactly as in the Registry schema (doc 07).

Divergence between code and docs is treated as a bug in whichever is wrong — fix one to match, don't let them drift.

---

Next: [18 · AI Roadmap →](./18-ai-roadmap.md)

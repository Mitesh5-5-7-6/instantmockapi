# 15 · Testing

← [14 · Performance](./14-performance.md) · [Master Index](./README.md) · Next: [16 · Roadmap](./16-roadmap.md)

Testing strategy across the monorepo. The design pays off here: **pure generators** (doc 09) make the highest-risk code deterministically testable, and the **Artifact Registry** gives a single state machine to verify.

---

## 1. Testing Pyramid

```
        ▲  E2E (Playwright) — few, critical user journeys
       ─┴─  Integration — API contracts, hosted mock API, workers+queue
      ──┴──  Unit — generators (golden files), parsers, registry state machine
```

Most confidence comes from the wide unit base (generators/parsers are pure and cheap to test exhaustively); E2E covers the handful of journeys that must never break.

## 2. Unit Tests

### Generators — golden-file tests (the core safety net)
- Every generator is a pure function `(IPS, generationConfig) → artifact`, so tests are: **IPS fixture in → assert byte-stable expected output**.
- One golden file per generator per representative IPS (flat entity, nested objects, arrays of objects, the 4-level demo schema, all validation-rule types).
- Covers Worker A (JSON Schema), B (Zod, Yup), C (TypeScript), D (Mock Data — seeded RNG for determinism), E (OpenAPI, Postman), plus stretch generators as they land.
- **Determinism rule:** Worker D uses a fixed seed in tests so faker output is reproducible.

### Parsers — fixture suites per input format
- `json-adapter`, `swagger-adapter`, `docs-adapter`: input fixture → expected IPS.
- Must cover type inference, format suggestions (email/phone/url), and **structured parse errors** pointing at the offending path (`addresses[0].location.city`).
- **Nesting depth cap** (default 10): a too-deep fixture must be rejected with the correct error.

### Registry state machine — exhaustive transitions
- Verify every legal transition (`pending → generating → completed | failed`) and reject illegal ones.
- Verify partial-job semantics: a failed worker yields `failed_partial` at the job level, never a global fail (doc 07, `jobs.status`).
- Verify versioning: each generation stamps the correct artifact version.

## 3. Integration Tests

### Platform API contract tests
- Each endpoint (doc 08): auth required, ownership enforced (`403`/`404` on cross-tenant), correct status codes, uniform error shape, pagination/filter/sort envelope.
- Job creation: idempotency key dedupes duplicates; plan concurrency returns `queued` when the limit is hit.

### Hosted Mock API integration tests (highest-risk surface)
- CRUD over generated endpoints for the selected methods.
- **Unselected method → 405**; invalid write → **422** with field-level errors from the generated validation (doc 13, §3).
- **Tenant isolation:** one project cannot read/mutate another's `mockStores`.
- Pagination bounds honored (max `limit`); payload caps enforced.
- Post-expiry: hosted route stops resolving (returns not-found) after cleanup (doc 10, §9).

### Workers + Queue tests
- **Retry:** a transient failure auto-retries with backoff; after attempts exhausted, artifact is `failed` and manual retry re-runs **only** that worker, leaving siblings intact (doc 10, §6).
- **DAG ordering:** E/F don't start until D completes; G bundles only produced artifacts.
- **Concurrency & idempotency:** rapid duplicate job creation collapses to one job; plan slot limits respected.
- **Cleanup worker:** expired project → hosted assets hard-deleted, shell (`projects`/`versions`) kept, status → `expired` (doc 07, §6).

## 4. End-to-End Tests (Playwright)

Cover the critical dashboard journeys with **production-grade, executable** Playwright suites (no pseudo-code). Structure: `playwright.config.ts`, page-object-model, reusable helpers, fixtures, auth-session handling, and test-data utilities.

Required E2E coverage:
- **Login flow** and **authentication persistence** (session survives reload).
- **CRUD operations** — creating a project through the wizard actually appears on the dashboard; hosted playground create/read/update/delete.
- **Drawer/modal** — artifact View modal, Regenerate modal, version Restore.
- **Table pagination** — dashboard/project lists paginate correctly.
- **Search / filter** — filter projects by status, search by name.
- **Sidebar navigation** — every nav destination reachable, no dead ends.
- **Form validation** — Schema Builder + Configure step reject invalid input with correct, interface-voice messages.
- **Responsive** — full flow works down to mobile; nested builder groups collapse gracefully.
- **Error handling** — failed worker shows Retry; API errors render specific messages, not stack traces.
- **Loading states** — skeletons/spinners appear and resolve; no blank screens.
- **Performance with large data** — dashboards/lists and hosted list endpoints stay responsive with many projects/records.

The end-to-end **happy path** (Dashboard → Input → Configure → Review → Progress → Project page → Download/Playground) is the single most important E2E and runs on every PR.

## 5. Non-Functional / Specialized Tests

- **Performance checks:** assert full generation of a ≤5-entity project stays within budget (critical-path bound, doc 14); hosted-API reads are cache-served.
- **Accessibility:** automated checks for contrast, focus visibility, and reduced-motion behavior in both themes (doc 12, §9).
- **Security-adjacent:** authz denial paths, rate-limit `429`s, payload-cap rejections, depth-cap rejections (doc 13).

## 6. Test Data & Fixtures

- Canonical IPS fixtures shared across generator/parser tests (including the 4-level demo schema) live with the `ips` package so every consumer tests against the same shapes.
- Seeded RNG for mock-data tests guarantees reproducibility.
- E2E fixtures/factories create isolated users/projects per test run and clean up after.

## 7. Coverage & CI

- **Generators and parsers:** high coverage expected (they're pure and central) — every rule/type path exercised.
- **CI (Turborepo affected-only):** `lint · typecheck · test · build` run per affected package on every PR; **dependency-cruiser** enforces the import graph (doc 05, §4) as a build-failing check.
- E2E happy-path runs on every PR; the full E2E matrix runs on merge to main / nightly.
- A PR is mergeable only when unit + integration + affected E2E pass and the dependency graph is clean.

## 8. Testing Rules (summary → coding standard, doc 17)

1. Every generator ships with golden-file tests; no generator merges without them.
2. Every parser ships fixture suites covering success + structured errors.
3. Mock-data tests are deterministic (fixed seed).
4. Registry transition tests are exhaustive.
5. New API endpoints require contract tests; hosted-API changes require isolation + validation tests.
6. E2E tests are real and executable — never pseudo-code.

---

Next: [16 · Roadmap →](./16-roadmap.md)

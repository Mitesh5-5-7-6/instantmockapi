# 13 · Security

← [12 · Design System](./12-design-system.md) · [Master Index](./README.md) · Next: [14 · Performance](./14-performance.md)

Security spans two attack surfaces: the **platform API** (control plane) and the **hosted mock API** (user-defined, internet-exposed, multi-tenant). The second is the higher-risk surface — InstantMockAPI runs APIs whose shape strangers define.

---

## 1. Authentication

- **JWT access tokens** issued on login (OAuth provider or email), short-lived, with refresh tokens (doc 06). Verified by shared `packages/auth` in both `api` and `mock-runtime`.
- Tokens are signed and validated server-side; no trust in client-supplied identity.
- Session refresh + logout invalidation via `/v1/auth/*` (doc 08, §2).

## 2. Authorization

- **Ownership checks on every project operation.** `ownerId` on `projects` (doc 07) is verified against the token subject; cross-tenant access returns `403`/`404` (404 to avoid leaking existence).
- **Plan gates** resolve from `packages/config`: hosted-API lifetime (2/7/30 days) and concurrency (1/3/∞ jobs) are enforced server-side at job creation, never assumed from the client.
- Principle of least privilege: `apps/web` holds no direct DB/storage access — it can only do what the API authorizes.

## 3. Input Validation (two enforcement points)

1. **Platform API input** — every request body validated against strict schemas (Fastify schema validation), rejecting malformed input with `400`/`422` and field-level detail (doc 08, §7). This includes the IPS itself: type enums, required shapes, and the **nesting depth cap (default 10)** are enforced before an IPS is accepted or a job is created.
2. **Hosted API input** — writes to a hosted mock endpoint are validated against that project's **generated validation rules** (the same rules that produced its Zod/Yup), returning `422` with field errors on invalid payloads. The generated rules are the runtime guard, so the hosted API behaves like the schema promises.

## 4. Mock Runtime Isolation & Safety (highest-risk surface)

- **Tenant isolation:** every project's `mockStores` are namespaced by `projectId`; routing resolves strictly within the authenticated/opened project. One project can never read or mutate another's data.
- **No code execution of user input.** The mock runtime is a **data-driven CRUD engine** — it interprets the generated *config* and *seed data*; it never `eval`s user schemas or executes user-supplied code. Generated validator code (Zod/Yup files) is a downloadable artifact, not something the runtime executes against live traffic; the runtime enforces rules via a safe interpreter over the IPS validation model.
- **Payload caps:** maximum request body size and maximum records/collection size per project, preventing memory-exhaustion via giant writes.
- **Query bounds:** pagination `limit` capped (max 100) so list endpoints can't be forced to return unbounded data.

## 5. Rate Limiting & Abuse Prevention

| Surface | Limit | Purpose |
|---|---|---|
| Platform API | Per-user token bucket (e.g., 100 req/min), `429` + `Retry-After` | Protect control plane |
| Generation | Plan concurrency (Free 1 / Pro 3 / Enterprise ∞) + idempotency dedupe | Stop 50 rapid clicks becoming 50 expensive jobs (doc 10, §5) |
| Hosted mock API | **Per-project** rate limits | Stop a public URL being used as free unbounded hosting/traffic sink |
| Schema builder | Nesting depth cap + entity/field count caps | Stop pathological IPS that explode generation cost |

- **Idempotency keys** (`hash(projectId, ipsVersion, config)`) prevent duplicate job storms (doc 07, `jobs.idempotencyKey`).
- Abuse signals (sustained hosted-API traffic spikes, oversized payloads) are logged for review; hosted APIs are inherently ephemeral (2/7/30-day expiry) which bounds abuse windows.

## 6. Data Handling & Secrets

- **Secrets** (DB/Redis/storage credentials, JWT signing keys, OAuth secrets) come from environment via `packages/config` — never committed, never shipped to the client.
- **Blob storage** references (`storageRef`) are server-mediated; downloads are authorized through the API, not via guessable public URLs.
- **Least data:** InstantMockAPI stores requirements + generated artifacts + mock data — not production user data. Expiry hard-deletes hosted assets, shrinking the standing data footprint (doc 07, §6).
- Transport: HTTPS everywhere (platform API and hosted API).

## 7. Hosted URL Exposure

- Hosted mock URLs (`/p/{projectId}/…`) are internet-reachable by design (frontends consume them). Because they carry only mock data and expire on schedule, exposure risk is bounded; sensitive real data should never be placed in a mock store (surfaced as guidance in the UI).
- On expiry/cleanup the route stops resolving (doc 10, §9), so stale URLs return not-found rather than serving orphaned data.

## 8. Boundaries That Double as Security

The architecture rules from doc 05 are also security controls:
- Generators are **pure** `(IPS, config) → output` with no I/O — they can't reach the network, DB, or filesystem, shrinking their blast radius.
- Only `apps/api` creates jobs; only `registry` changes artifact status; `apps/web` talks HTTP only. Each boundary limits what a compromised component can do.

## 9. Auditing & Observability (security-relevant)

- Auth events (login, refresh, failed auth) and authorization denials are logged.
- Job creation, retries, and cleanup/expiry actions are recorded (doc 10, §10).
- Hosted-API request logs (`apiLogs`, TTL-retained) support abuse investigation without retaining data forever.

## 10. Not in V1 (tracked)

- Team/RBAC multi-user permissions (arrives with team features, doc 16).
- Custom auth on hosted mock APIs (e.g., requiring a key to call a mock) — candidate enhancement; V1 relies on unguessable IDs + expiry + rate limits.
- Bring-your-own-domain for hosted APIs.

---

Next: [14 · Performance →](./14-performance.md)

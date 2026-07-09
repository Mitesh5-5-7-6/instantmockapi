# 08 · API Design

← [07 · Database Design](./07-database-design.md) · [Master Index](./README.md) · Next: [09 · Generator Engine](./09-generator-engine.md)

There are **two distinct HTTP surfaces**. Don't confuse them:

1. **Platform API** (`apps/api`) — the app's own control-plane REST API (projects, jobs, artifacts, auth, billing). This document.
2. **Hosted Mock API** (`apps/mock-runtime`) — the *generated* per-project CRUD API at `api.InstantMockAPI.dev/p/{projectId}/…`. Its shape is defined by the user's schema + selected methods (doc 04, §F8); only its conventions are summarized here (§9).

REST only in V1. **GraphQL is deferred** (non-goal, doc 02, §3).

---

## 1. Conventions

- Base: `https://api.InstantMockAPI.dev/v1` — version in the path.
- JSON request/response bodies; `Content-Type: application/json`.
- Resource-oriented nouns, plural: `/projects`, `/jobs`, `/artifacts`.
- Auth via `Authorization: Bearer <jwt>` on every endpoint except auth/login.
- All timestamps ISO-8601 UTC.

## 2. Authentication

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v1/auth/login` | Exchange credentials/OAuth code for a JWT |
| POST | `/v1/auth/refresh` | Refresh an access token |
| POST | `/v1/auth/logout` | Invalidate session |
| GET | `/v1/me` | Current user + plan |

Authorization: every `/projects/*` route checks ownership; plan gates (concurrency, lifetime) resolve from `packages/config`. See doc 13 (Security).

## 3. Projects

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/projects` | List (paginated, filterable, sortable) |
| POST | `/v1/projects` | Create a project (from input source) |
| GET | `/v1/projects/{id}` | Fetch shell + current IPS + config + hosted info |
| PATCH | `/v1/projects/{id}` | Rename, edit IPS/config in Review |
| DELETE | `/v1/projects/{id}` | Hard-delete everything (doc 07, §7) |
| POST | `/v1/projects/{id}/parse` | Re-parse input → refreshed IPS draft |

**Create body (example):**
```jsonc
POST /v1/projects
{
  "name": "CRM Backend",
  "inputSource": { "type": "json", "raw": { "customer": { "email": "a@b.com" } } }
}
→ 201 { "id": "…", "status": "draft", "ips": { … } }
```

## 4. Generation Jobs

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v1/projects/{id}/generate` | Create a **full** Generation Job from current IPS + config |
| POST | `/v1/projects/{id}/regenerate` | Create a **partial** job for selected artifacts |
| POST | `/v1/projects/{id}/generate-again` | Re-run from the kept shell after expiry |
| GET | `/v1/jobs/{jobId}` | Job + per-worker status snapshot |
| GET | `/v1/jobs/{jobId}/stream` | **SSE** live progress (pending→generating→completed/failed) |
| POST | `/v1/jobs/{jobId}/workers/{worker}/retry` | Retry **one** failed worker |

**Generate body:**
```jsonc
POST /v1/projects/{id}/generate
{
  "generationConfig": {
    "validators": ["zod", "yup"],       // + "jsonschema" via Advanced
    "types": ["typescript"],
    "methods": ["GET", "POST"],
    "mockRecords": 25
  }
}
→ 202 { "jobId": "…", "status": "queued" }   // async; poll or stream
```

**Regenerate body (per-asset):**
```jsonc
POST /v1/projects/{id}/regenerate
{ "artifacts": ["zod"] }               // only Worker B re-runs; new version stamped
→ 202 { "jobId": "…" }
```

**Concurrency:** if the plan's active-job limit is hit (Free 1 / Pro 3 / Enterprise ∞), the job is accepted but returns `status: "queued"`; duplicate rapid calls with the same idempotency key return the **existing** job, not a new one (doc 07, `jobs.idempotencyKey`).

## 5. Artifacts & Versions

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/projects/{id}/artifacts` | Registry list (status, version, timestamps, workerId) |
| GET | `/v1/projects/{id}/artifacts/{type}` | One artifact incl. content or `storageRef` |
| GET | `/v1/projects/{id}/artifacts/{type}/download` | Download a single artifact file |
| GET | `/v1/projects/{id}/export` | Download the full **ZIP** bundle |
| GET | `/v1/projects/{id}/versions` | Version history |
| POST | `/v1/projects/{id}/versions/{version}/restore` | Restore a snapshot (doc 03, §7) |

## 6. Pagination, Filtering, Sorting, Search

- **Pagination:** `?page=1&limit=20` (default limit 20, max 100). Responses include `meta: { page, limit, total }`.
- **Filtering:** `?status=active`, `?plan=pro`.
- **Sorting:** `?sort=-updatedAt` (leading `-` = descending).
- **Search:** `?q=crm` matches project name.

Consistent list envelope:
```jsonc
{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 42 } }
```

## 7. Errors

Uniform error shape; correct HTTP status codes:
```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",       // machine-readable
    "message": "Human-readable summary",
    "details": [                       // optional, field-level
      { "path": "generationConfig.methods", "issue": "must be a non-empty subset of GET,POST,PUT,PATCH,DELETE" }
    ]
  }
}
```

| Status | When |
|---|---|
| 400 | Malformed request / bad input |
| 401 | Missing/invalid token |
| 403 | Authenticated but not owner, or plan-gated |
| 404 | Resource not found |
| 409 | Idempotency conflict / duplicate |
| 422 | Semantic validation failure (e.g., invalid IPS, unparseable input) |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |

## 8. Rate Limits

- Platform API: per-user token-bucket (e.g., 100 req/min) returning `429` with `Retry-After`.
- Generation is additionally gated by **plan concurrency** (not just request rate) — the real throttle on expensive work.
- Hosted Mock API has its **own** per-project limits (see §9).

## 9. Hosted Mock API — Conventions (summary)

The generated API is separate from the platform API. Shape is derived from the schema + selected methods:

| Pattern | Meaning |
|---|---|
| `GET /p/{projectId}/{entity}` | List (paginated `?page&limit`) from seed data |
| `GET /p/{projectId}/{entity}/{recordId}` | Single record |
| `POST /p/{projectId}/{entity}` | Create (validated against generated rules) |
| `PUT/PATCH /p/{projectId}/{entity}/{recordId}` | Replace / update |
| `DELETE /p/{projectId}/{entity}/{recordId}` | Remove |

- Unselected methods return **405**; invalid writes return **422** with field-level errors from the generated validation.
- Read endpoints always have seed data (doc 04, §F7). Per-project rate limits + logging apply.
- The URL stops resolving once `hosted.expiresAt` passes and cleanup runs (doc 07, §6).

## 10. Versioning of the API Itself

- Path-versioned (`/v1`). Breaking changes ship under `/v2`; `/v1` remains until deprecation.
- The **hosted** mock API is versioned by the project's IPS version, not by this platform API version.

---

Next: [09 · Generator Engine →](./09-generator-engine.md)

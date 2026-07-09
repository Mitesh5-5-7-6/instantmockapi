# 07 · Database Design

← [06 · Tech Stack](./06-tech-stack.md) · [Master Index](./README.md) · Next: [08 · API Design](./08-api-design.md)

Database: **MongoDB**. Blobs (generated files, ZIPs) live in object storage; Mongo holds documents, metadata, and references (`storageRef`).

---

## 1. Collections Overview

| Collection | Holds | Survives expiry? | TTL? |
|---|---|---|---|
| `users` | Accounts, plan, auth linkage | — | No |
| `projects` | **The project shell** + current IPS + generationConfig | ✅ **Yes** | **Never** |
| `versions` | Immutable IPS + config snapshots per generation | ✅ Yes | No |
| `artifacts` | The **Artifact Registry** — one record per generated asset | metadata yes, files deleted | No (metadata) |
| `jobs` | Generation jobs + per-worker status | ✅ Yes | Optional (old jobs) |
| `mockStores` | **Hosted seed data** the mock API reads/writes | ❌ Hard-deleted | Optional |
| `apiLogs` | Hosted-API request logs / analytics | ❌ Cleaned | ✅ Yes (rolling) |

The dividing line is the locked decision: **on expiry, hosted assets are hard-deleted while the project shell survives.** So `projects` and `versions` are permanent; `mockStores`, stored files, and `apiLogs` are ephemeral.

## 2. Collection Schemas

### `users`
```jsonc
{
  "_id": "ObjectId",
  "email": "string",              // unique
  "authProvider": "string",       // e.g. "google" | "email"
  "plan": "free | pro | enterprise",
  "createdAt": "Date",
  "updatedAt": "Date"
}
```

### `projects` — the surviving shell
```jsonc
{
  "_id": "ObjectId",
  "ownerId": "ObjectId",          // → users._id
  "name": "string",
  "status": "draft | generating | active | expired",
  "inputSource": {                // original input, kept for regeneration
    "type": "json | swagger | builder | docs",
    "raw": "…"                    // or storageRef for large uploads
  },
  "ips": { /* current Internal Project Schema — see doc 04 §F3 */ },
  "currentVersion": 3,
  "generationConfig": {
    "validators": ["zod", "yup"], // + "jsonschema" (Advanced)
    "types": ["typescript"],
    "methods": ["GET", "POST"],
    "mockRecords": 25
  },
  "hosted": {                     // cleared on expiry, shell remains
    "url": "string | null",
    "expiresAt": "Date | null"    // drives countdown + cleanup
  },
  "createdAt": "Date",
  "updatedAt": "Date"
  // NOTE: no TTL on this collection — the shell must never auto-delete
}
```

### `versions` — immutable snapshots
```jsonc
{
  "_id": "ObjectId",
  "projectId": "ObjectId",
  "version": 3,
  "ipsSnapshot": { /* frozen IPS at generation time */ },
  "configSnapshot": { /* frozen generationConfig */ },
  "createdAt": "Date"
}
```
Restore = copy a snapshot's `ipsSnapshot`/`configSnapshot` back onto `projects`; the next generation stamps a new version (doc 03, §7).

### `artifacts` — the Registry
```jsonc
{
  "_id": "ObjectId",
  "projectId": "ObjectId",
  "artifactType": "ips | json_schema | zod | yup | typescript | mock_data | openapi | postman | hosted_api | export_zip",
  "version": 3,
  "status": "pending | generating | completed | failed",
  "workerId": "string | null",
  "generatedAt": "Date | null",
  "errorMessage": "string | null",
  "storageRef": "string | null"   // object-storage key; nulled when file is hard-deleted
}
```
Unique per `(projectId, artifactType, version)`. This is the **only** source the UI reads artifact state from (doc 04, §F12).

### `jobs` — generation runs
```jsonc
{
  "_id": "ObjectId",
  "projectId": "ObjectId",
  "version": 3,
  "type": "full | partial",       // partial = per-asset regeneration / retry
  "requestedArtifacts": ["zod", "typescript", "mock_data", "hosted_api", "export_zip"],
  "idempotencyKey": "string",     // hash(projectId, version, config) — dedupes rapid clicks
  "status": "queued | running | completed | failed_partial",
  "workers": [                    // per-worker progress for the live board
    { "worker": "B", "artifactType": "zod", "status": "completed" },
    { "worker": "D", "artifactType": "mock_data", "status": "failed", "error": "…" }
  ],
  "createdAt": "Date",
  "completedAt": "Date | null"
}
```
Note `failed_partial` — reflecting the rule that **a project never fully fails**; individual workers fail and are retried (doc 03, §4).

### `mockStores` — hosted data (ephemeral)
```jsonc
{
  "_id": "ObjectId",
  "projectId": "ObjectId",
  "entity": "Customer",
  "records": [ { /* seed/generated record */ } ],  // mutated by hosted POST/PUT/PATCH/DELETE
  "createdAt": "Date"
  // hard-deleted by the cleanup worker on expiry
}
```

### `apiLogs` — hosted-API analytics (ephemeral, TTL)
```jsonc
{
  "_id": "ObjectId",
  "projectId": "ObjectId",
  "method": "GET",
  "path": "/p/{projectId}/customers",
  "status": 200,
  "at": "Date"                    // TTL index expires old logs on a rolling window
}
```

## 3. Indexes

| Collection | Index | Purpose |
|---|---|---|
| `users` | `{ email: 1 }` unique | Login lookup |
| `projects` | `{ ownerId: 1, updatedAt: -1 }` | Dashboard listing |
| `projects` | `{ status: 1, "hosted.expiresAt": 1 }` | Cleanup worker scan for due expirations |
| `versions` | `{ projectId: 1, version: -1 }` | Version history |
| `artifacts` | `{ projectId: 1, artifactType: 1, version: 1 }` unique | Registry lookups / upserts |
| `artifacts` | `{ projectId: 1, status: 1 }` | Progress board queries |
| `jobs` | `{ projectId: 1, createdAt: -1 }` | Job history |
| `jobs` | `{ idempotencyKey: 1 }` unique | Dedupe duplicate job creation |
| `mockStores` | `{ projectId: 1, entity: 1 }` | Fast hosted-API reads/writes |
| `apiLogs` | `{ at: 1 }` **TTL** | Rolling log retention |

## 4. Relationships

MongoDB references (not embeds) between top-level entities:

```
users (1) ──< projects (N)
projects (1) ──< versions (N)
projects (1) ──< artifacts (N)
projects (1) ──< jobs (N)
projects (1) ──< mockStores (N)   ← ephemeral
projects (1) ──< apiLogs (N)      ← ephemeral, TTL
```

The **IPS itself is embedded** in `projects` (and snapshotted in `versions`) because it's always read and written as a whole — no cross-document joins on field-level data.

## 5. Versioning Strategy

- Every generation (full or partial) writes a `versions` snapshot and bumps `projects.currentVersion`.
- `artifacts` carry the `version` they were produced at, so the Registry can show "Zod is v3, Mock Data is v2" after a partial regeneration.
- **Restore** copies an old snapshot forward (never mutates history) — snapshots are immutable.

## 6. Expiry & TTL Model (the important part)

The naive approach — a Mongo TTL index that deletes projects — is **wrong here**, because the project shell must survive. Instead:

1. **Scheduled cleanup worker** (doc 10) scans `projects` via `{ status: "active", "hosted.expiresAt": ≤ now }` and, for each due project:
   - deletes object-storage files for that project (Zod/TS/docs/ZIP),
   - nulls each artifact's `storageRef` and marks hosted-dependent artifacts accordingly,
   - hard-deletes the project's `mockStores` documents,
   - clears `projects.hosted` (`url` and `expiresAt` → null),
   - sets `projects.status = "expired"`.
2. **TTL is used only on truly ephemeral collections** — `apiLogs` (rolling retention), and optionally `mockStores`/old `jobs` as a backstop. **Never on `projects` or `versions`.**
3. Lifetime source of truth is `hosted.expiresAt`, set at generation from plan limits (`packages/config`): Free +2 days, Pro +7 days, Enterprise +30 days.

Result: storage stays bounded (hosted assets gone), while **Generate Again** works instantly because `projects.ips` + `generationConfig` are still present (doc 03, §5).

## 7. Delete Semantics

| Trigger | Effect |
|---|---|
| **Expiry** | Hard-delete hosted assets (files, `mockStores`, hosted config); keep shell; status → `expired` |
| **User deletes project** | Hard-delete everything for that project across all collections + storage (no soft-delete flag) |
| **Generate Again / Regenerate** | New job; new/overwritten artifact records + files; new version snapshot |

There is **no soft-delete** on projects — the "keep the shell" behavior is expiry-specific, not a `deletedAt` flag. (This supersedes the original spec's generic "soft delete" note.)

---

Next: [08 · API Design →](./08-api-design.md)

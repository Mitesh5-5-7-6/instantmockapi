# Architecture: the three definitions, and the one that changes production

This document exists to defend a single boundary. If you change one thing in this
repository without understanding it, this is the thing.

## The rule

> **The draft is the editing surface. The version is the immutable generation
> candidate. The published version is the runtime authority.**

Three separate responsibilities, three separate documents, and they must never
collapse into each other:

| Concept                    | Means                           | Stored in                        | Mutable? |
| -------------------------- | ------------------------------- | -------------------------------- | -------- |
| `ProjectDraft`             | mutable **intent**              | `projectdrafts` collection       | yes      |
| `Project.currentVersion`   | the canonical **definition**    | `projects.currentVersion`        | advances |
| `Version`                  | immutable **generated state**   | `versions` (one doc per version) | never    |
| `Project.publishedVersion` | immutable **runtime selection** | `projects.publishedVersion`      | promotes |

## What follows from it

```
PATCH /draft        ≠   change production
POST  /draft/commit ≠   publish production
generate            ≠   publish production
promote             =   change production
```

Only the last line touches what a caller of a hosted mock API receives. Anything
that appears to shortcut it is a bug, however convenient it looks.

```
 v4 published ─────────────────────────────────────────────▶ still serving
      │
      ├─ fork ──▶ DRAFT ──▶ edit ──▶ diff ──▶ graph ──▶ impact
      │                                                    │
      │                                              user confirms
      │                                                    │
      │                                                 commit
      │                                                    │
      │                                        v5 definition, PENDING
      │                                                    │
      │                                                generate
      │                                                    │
      │                                    ┌───────────────┴───────────────┐
      │                                    │                               │
      │                            hosted_api ready              openapi failed
      │                                    │                               │
      │                                    └───────────────┬───────────────┘
      │                                                    │
      │                                          runtime readiness
      │                                                    │
      └──────────────────────────────────────────────▶ promote
                                                           │
                                                     v5 published
```

## Where each boundary is enforced

Named so this document cannot quietly become fiction — if you delete one of
these, the rule above is no longer true regardless of what this file says.

| Boundary                                                        | Enforced by                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The runtime resolves `publishedVersion`, never `currentVersion` | `publishedVersionOf` in `packages/db/src/published-version.ts`, called by `apps/mock-runtime/src/hosting.ts` |
| Editing never moves the served version                          | `pinPublishedVersion` before every `currentVersion += 1`                                                     |
| Generation never targets the live version                       | `wouldDisturbLiveRuntime` guard in `apps/api/src/generation-service.ts`                                      |
| Promotion is gated on runtime readiness, not on all artifacts   | `evaluatePromotion` / `RUNTIME_REQUIRED_ARTIFACTS` in `packages/shared/src/promotion.ts`                     |
| A commit cannot be based on a definition that has moved         | the `STALE_DRAFT` check in `apps/api/src/draft-service.ts`                                                   |
| A risky change cannot be committed unseen                       | `needsAttention` + the `acknowledgeImpact` digest, same file                                                 |

## The ordering that is sacred

```
pinPublishedVersion(project);     //  FIRST
project.currentVersion += 1;      //  THEN
```

Reversed, this is an outage, and only on projects that predate
`publishedVersion`. `publishedVersionOf` falls back to `currentVersion` when
`publishedVersion` is null — and **a fallback follows the field it falls back
to**. Bumping first makes the pin capture the bumped value, so the hosted URL
immediately resolves a version that has no artifacts.

Guarded by `legacy project pins published runtime before currentVersion advances`
in `apps/api/src/routes/edit-lifecycle.test.ts`. Every other test in that file
sets `publishedVersion` explicitly, which makes the pin a no-op whatever the
order — so that one test is the only thing standing between a two-line
"cleanup" and a production outage.

## Impact analysis is computed in one place

`packages/ips` owns the whole chain, with no I/O:

```
diffSchemas         changes.ts    what changed, at what risk
buildDependencyGraph  graph.ts    what reads what
analyseImpact        impact.ts    which APIs are affected, and why
```

Clients — the web editor, the confirmation dialog, the version comparison view —
**render** this. They do not recompute it. A second implementation in the
frontend would eventually disagree with the backend about what a change means,
and the user would be shown two different answers to the same question.

The precision rule the graph exists for: _an endpoint depends on a field only if
the field crosses its wire._ `DELETE /user/{id}` sends a path parameter and
returns no body, so changing `age` does not affect it. An impact report that
over-reports trains people to ignore it.

## Routing identity has one definition

`entitySlug(entity)` in `packages/shared/src/routing.ts`. Six systems consume it,
including the hosting runtime, both docs generators, and traffic attribution
(`ApiLog.entity` stores the route segment). A second `toLowerCase()` anywhere
means documentation advertising a URL the runtime answers 404 on.

Generated **filenames** (`user.types.ts`, `user.zod.ts`) deliberately do _not_
use it. A filename is not a URL.

## Not in scope here

Authentication is Phase 3 and must consume this model rather than contaminate
it. Versioning UI, visual diff and rollback are Phase 2. Neither should require
changing anything above.

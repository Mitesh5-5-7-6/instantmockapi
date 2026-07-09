# 10 · Worker Engine

← [09 · Generator Engine](./09-generator-engine.md) · [Master Index](./README.md)

Where [09](./09-generator-engine.md) defines *what each generator produces*, this document defines *how jobs are scheduled, run, retried, and reported*. Runtime lives in `apps/workers`; queue/retry primitives in `packages/queue`; status in `packages/registry` (doc 05).

Stack: **BullMQ on Redis**, Node.js worker processes (doc 06).

---

## 1. From Click to Completion

```
POST /generate (doc 08)
   │
   ▼
Create job doc (doc 07 `jobs`) with idempotencyKey
   │
   ▼
Enqueue job on BullMQ (Redis)
   │
   ▼
Worker process picks up → expands into per-worker tasks per generationConfig
   │
   ▼
Run A/B/C/D in parallel → E,F after D → G last   (the DAG, doc 09 §6)
   │
   ▼
Each task writes artifact status to Registry → API streams SSE to the board
   │
   ▼
All selected tasks settle → job status set → user notified
```

## 2. The Workers

| Worker | Produces | Depends on | Runs when |
|---|---|---|---|
| A | JSON Schema | IPS | `validators` includes `jsonschema` (Advanced) |
| B | Zod, Yup | IPS | any of those validators selected |
| C | TypeScript | IPS | `types` includes `typescript` |
| D | Mock Data (seed/JSON/examples) | IPS | always (core artifact) |
| E | OpenAPI, Postman | **D** (examples) | docs requested / methods selected |
| F | Hosted API config | **D** (seed) | `methods` non-empty |
| G | Export ZIP | all produced artifacts | any downloadable produced |

Workers are **stateless**: everything they need comes from the job payload + IPS snapshot; they write results to Registry + object storage and hold no local state between tasks. Add replicas to scale throughput.

## 3. Job Types

- **Full** — first generation or post-edit: runs every worker the config implies.
- **Partial** — per-asset **regeneration** or **retry**: runs only the named workers, still respecting the DAG (e.g., regenerating Mock Data will re-run E and F if they were part of the project).

## 4. Scheduling & the DAG

The worker process reads `generationConfig`, computes the set of required workers, and schedules them by dependency level:

```
Level 0 (parallel):  A · B · C · D
Level 1 (after D):    E · F
Level 2 (after L1):   G
```

- Level 0 tasks fan out immediately (BullMQ concurrency per replica).
- E/F are gated on D's `completed` status in the Registry.
- G is gated on completion of all other **selected** tasks (it bundles whatever exists).
- If a level-0 task other than D fails, D-dependent tasks are unaffected; only G waits for the failed one to eventually succeed (or is bundled without it on explicit user choice).

## 5. Concurrency Model

Two independent throttles:

1. **Per-user plan concurrency** (the business limit): active **jobs** per user — Free 1 · Pro 3 · Enterprise ∞ (`packages/config`). Excess `POST /generate` calls are accepted but the job sits `queued` until a slot frees (doc 08, §4).
2. **Per-replica worker concurrency** (the infra limit): how many generator tasks one worker process runs at once — tuned per deployment, independent of plan.

**Idempotency:** job creation uses `idempotencyKey = hash(projectId, ipsVersion, config)` with a unique index (doc 07). Rapid duplicate clicks resolve to the **same** job — never N expensive jobs (doc 03, §8).

## 6. Retry Strategy

- **Per-task retry** with exponential backoff on transient failures (BullMQ `attempts` + `backoff`), e.g. 3 automatic attempts before a task is marked `failed`.
- After automatic attempts are exhausted, the artifact is `failed` in the Registry with `errorMessage`, and the UI shows a manual **Retry** button.
- **Manual retry re-enqueues only that one worker** with the same job context; completed siblings are untouched; DAG dependents resume once the dependency reaches `completed` (doc 03, §4).
- Retries are idempotent: re-running a generator overwrites that artifact's record/file for the current version.

## 7. Failure Handling — partial, never total

- A worker failure is **isolated** to its artifact. The job never enters a global `failed` state; it settles as `failed_partial` if any task ended failed (doc 07, `jobs.status`).
- The user always keeps whatever succeeded — completed artifacts are downloadable and the hosted API can still come up if F succeeded.
- This is the core reliability promise from doc 01 (§Philosophy) and doc 02 (FR-7.3).

## 8. Progress Reporting

- Each task transition (`pending → generating → completed | failed`) is written to the Registry and to the job's `workers[]` array.
- `apps/api` subscribes to these changes and pushes **SSE** to the Progress board (doc 08, `/jobs/{jobId}/stream`); the board renders live checkmarks/spinners/errors.
- A **progress aggregator** derives overall job % from settled vs. total selected tasks for the top progress bar.
- Because progress is Registry-driven, leaving and returning to the page shows the true current state (doc 03, §S5).

## 9. Scheduled / Background Workers

Beyond generation, two repeatable jobs run on the same worker infrastructure (BullMQ repeatable/delayed jobs):

| Worker | Trigger | Action |
|---|---|---|
| **Cleanup worker** | Scheduled scan | Finds `active` projects past `hosted.expiresAt`; hard-deletes hosted assets (files, `mockStores`, hosted config), nulls `storageRef`s, sets status `expired` — shell kept (doc 07, §6) |
| **Reminder worker** | Delayed jobs before expiry | Sends pre-expiry email + dashboard reminder with a Download ZIP nudge (doc 02, FR-9.5) |

Neither ever deletes `projects`/`versions` — only ephemeral, hosted data.

## 10. Observability

- Per-task: worker id, durations, attempt count, outcome, error — logged and stored on the artifact/job records.
- Per-job: total duration vs. the 3-minute budget (doc 02) for tracking activation performance.
- Queue health (depth, failure rate, retry rate) surfaced for ops.

## 11. Why This Holds

1. **Stateless workers + queue** → horizontal scale and clean retries.
2. **DAG scheduling** → docs/hosting reflect real mock data; exports reflect real artifacts.
3. **Two-axis concurrency** → plan limits protect cost; replica limits protect infra; they don't interfere.
4. **Registry-driven status** → one truth for the board, retries, regeneration, and versioning.
5. **Isolated failures** → a broken generator is one Retry button, never a dead project.

---

Back to [Master Index](./README.md)

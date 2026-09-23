# Infrastructure: what runs where, and why a request is sometimes slow

`ARCHITECTURE.md` is about one axis — the canonical definition versus the deployment that
serves it — and deliberately stays there. This is the other axis: the machines, the connections
between them, and the one performance characteristic users actually notice.

## Cold-start latency, stated correctly

> After inactivity, the first request may take significantly longer while the backend instance
> wakes and initializes. Warm requests should be fast.

This is worth being precise about because the wrong description leads somewhere else. It is **not**
"the first page load is slow, then everything is fast" — that would be a frontend bundle problem
with frontend remedies. The instance sleeps again after further inactivity, so the slow request
recurs, and from a caller's side it looks like an intermittently slow API rather than a one-time
cost.

The consequence for anyone reading logs: **a cold start and a slow database query are
indistinguishable from the outside.** Both are one slow request among fast ones. That is why the
request log records whether the instance had served anything yet — see [Observability](#observability).

### What actually happens on a cold request

```
User request
     │
     ▼
Render API instance
     │
     ├── instance warm
     │       └── fast response
     │
     └── instance sleeping / cold
             │
             ├── instance wake-up          (platform, not ours)
             ├── Node.js startup           (module graph, no expensive top-level work)
             ├── loadEnvConfig()           (process.env reads)
             ├── connectDB()               (awaited — see below)
             ├── createStorage(config)     (picks a driver; GridFS reuses the Mongo connection)
             ├── buildServer()             (route registration; ajv compiles schemas once)
             ├── app.listen()
             └── request processing
                     │
                     ▼
                  slower response
```

`await connectDB()` precedes `listen`, so the instance does not accept requests until MongoDB is
reachable. That is deliberate: an instance that answers requests it cannot serve turns one slow
response into a page of 500s. It does mean the connection is on the cold path, which is why the
initial connect retries rather than failing fast — up to `DB_CONNECT_MAX_ATTEMPTS` (15) with
`DB_CONNECT_RETRY_MS` (3s) backoff, each attempt bounded by `serverSelectionTimeoutMS: 8000`. Once
connected, the driver's own topology monitor handles reconnects and this loop is not re-entered.

Cold start is an infrastructure characteristic of the V1 deployment, not a defect to design around.
Nothing here should acquire complexity to eliminate it.

---

## MongoDB is the source of truth. Redis is disposable.

```
MongoDB = authoritative persistent state
Redis   = disposable infrastructure
```

MongoDB holds everything durable: users, projects, the canonical Project Definition (entities,
fields, relationships), API and authentication configuration, versions and the published pointer,
generation jobs and their status, blueprint-derived state, request logs.

Redis may hold: the BullMQ queue, caches, rate-limit counters, short-lived coordination. **Nothing
authoritative.** If Redis is flushed or unavailable, every project definition still exists in
MongoDB and the platform still serves reads.

That is not aspiration — it is how the code already behaves, in two places worth knowing about:

- **The cache degrades rather than fails.** Every Redis round trip funnels through `redisCall` in
  `packages/cache/src/service.ts`, which turns an outage into a cache _miss_ served from the loader.
  A hosted API with Redis down is slower, not broken.
- **The queue carries no definition.** `GenerationJobPayload` is `{projectId, version, type,
requestedArtifacts, jobId?}` and nothing else (`packages/queue/src/queue.ts`). A flushed Redis can
  lose _queued work_, which is recoverable by regenerating; it cannot lose a definition, because it
  never held one.

The one thing Redis being down does stop is _starting_ a generation, since the queue is Redis. That
is the correct blast radius: the definition is safe, the hosted API keeps serving, and the job can be
enqueued again.

---

## Two logical services

```
Management API                     Hosted API Runtime
├── authentication                 ├── GET
├── projects                       ├── POST
├── entities                       ├── PUT
├── versions                       ├── PATCH
├── blueprints                     ├── DELETE
├── generation                     └── authentication enforcement
└── project configuration
```

They are already separate applications — `apps/api` and `apps/mock-runtime`, each with its own
Fastify server and entry point — and the direction between them is enforced rather than trusted:
`.dependency-cruiser.mjs` fails the build on the couplings that would matter.

For V1 they may share infrastructure. What must not happen is the hosted runtime acquiring
dashboard-specific logic, because the runtime is the part that has to scale with a customer's
traffic rather than with the number of people using the dashboard.

**One deployment mode worth recording:** `RUN_WORKER_IN_PROCESS=true` (`apps/api/src/index.ts`) runs
the generation worker inside the API process, which is how a single-service free-tier deployment
works. The consequence follows directly and is easy to miss — **a scaled-out API is a multi-worker
deployment**, so anything that would be unsafe with several workers is already reachable with one
service and two replicas.

---

## Hosted API performance

Hosted mock APIs are more latency-sensitive than background generation: they are what a developer's
own application calls, so latency here shows up in _their_ app.

Measured cost of one hosted request:

|                     | MongoDB           | Redis | Object storage |
| ------------------- | ----------------- | ----- | -------------- |
| Warm (L1 cache hit) | 2 indexed queries | 0     | 0              |
| Cold cache          | 2 indexed queries | 2 GET | 2 reads        |

The two queries are the project lookup (`publicId`, indexed) and the `hosted_api` artifact row. The
project lookup uses a lean projection that **excludes `ips`** — the runtime never loads the full
project definition, only the compiled hosting config.

What does not happen per request: no artifact is generated, no schema is compiled, no validator is
built, and the hosting config JSON is not re-parsed on a cache hit. The cache key is
content-addressed (`mockcfg:{projectId}:v{version}:{generatedAt}`), so a stale hit is structurally
impossible and the TTL can be long.

Redis does not solve cold start. It removes repeated object-storage reads; it does nothing about
instance wake-up, and treating it as a latency fix would be reaching for the wrong tool.

---

## Generation is asynchronous

```
User
 │ Generate
 ▼
Management API ── validate ── create job ── enqueue ──► Upstash Redis
 │                                                            │
 └──► 202 { jobId, status }                                    ▼
                                                        Render Worker
                                                              │
                                                              ├── load authoritative version
                                                              │     from MongoDB
                                                              ├── generate artifacts, mock data,
                                                              │     OpenAPI, Postman, code
                                                              └── package
                                                                    │
                                                                    ▼
                                                          object store ──► MongoDB ──► READY
                                                        (GridFS in V1; see
                                                         Where artifacts live)
```

`POST /v1/projects/:id/generate` returns **202** with `{jobId, status}` before any generation runs.
Nothing generates inside a request handler.

**The queue carries identifiers; the worker loads the definition from MongoDB.** This is a rule, not
an implementation detail: the worker reads `Version.ipsSnapshot` (falling back to `project.ips`) and
takes addressing from the _live_ project document, so a slug renamed after the snapshot cannot
resurrect an old path. Redis job data is never the canonical definition.

The worker is allowed to be cold. Generation is asynchronous, so a wake-up delays a job rather than a
request, and the user watches status instead of holding an HTTP connection open.

### Worker reliability

- **Retry** — 3 attempts, exponential 5s backoff, at the queue level. Per-artifact failures are
  handled separately and deliberately do not fail the batch: one broken generator leaves the other
  eight artifacts intact.
- **Idempotency** — the job id is `sha256(projectId, version, config, requestedArtifacts, ips)`,
  enforced by both a pre-insert query and a unique index on `Job.idempotencyKey`.
- **Failed jobs reach a terminal state** — when BullMQ's attempts are spent, `onExhausted` settles
  the Mongo document to `failed_partial`. Without it, a throw outside per-artifact handling left the
  job on `running` forever and the client's progress stream waited out its five-minute cap on a job
  that was never coming back.
- **Progress** — the worker writes status to MongoDB with atomic positional updates; the API's SSE
  stream _polls MongoDB_. There is no in-process event bus, which is what makes progress work with
  any number of API instances: a client connected to instance A sees progress written by a worker
  that instance A has never spoken to.
- **Multiple workers** — the published pointer is moved under a compare-and-swap, matching the
  publish route, so a job that finishes after another writer moved it skips its promotion rather
  than applying a stale decision. `MockStore` is uniquely indexed on `(projectId, entity)`, so
  concurrent seeding of one entity cannot produce two record sets.
- **Cancellation** — not implemented. The nearest effect is deleting the project, which makes the
  worker abandon the job.

---

## Where artifacts live

**V1 stores generated artifacts in MongoDB GridFS, not in object storage.** The R2/S3 box in the
Phase 6 diagram is the documented upgrade path, not what is running.

`STORAGE_DRIVER` defaults to `mongo` (`packages/config/src/env.ts`), and `.env.example` sets it
explicitly. So every artifact — validators, types, OpenAPI, Postman, the hosted config, and the
`export_zip` bundle — goes into the `artifacts` GridFS bucket in the same cluster that holds the
project definitions.

GridFS rather than a plain collection because of the ZIP specifically: a BSON document caps at
16 MB and `export_zip` can exceed it.

This is a deliberate V1 trade-off, and both halves are worth stating:

- **For it:** no second service to provision, pay for, or hold credentials to. On a free-tier
  deployment that is the difference between working and not.
- **Against it:** artifact bytes compete with application data for the cluster's storage quota and
  I/O. Atlas shared tiers are small, and a few hundred projects' export bundles will notice it
  before the documents ever do.

Switching is an env change, not a code change — every call site asks for a `StorageClient` and the
factory picks the implementation:

```
STORAGE_DRIVER=s3
S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
```

Two things to know before flipping it. Nothing migrates existing objects — the keys are the same
(`artifactKey(projectId, version, type, filename)`) but the bytes are in GridFS, so previously
generated artifacts would 404 until regenerated. And `assertProductionSecrets` does **not** validate
storage config: a production instance with `STORAGE_DRIVER=s3` and missing credentials starts
normally and fails at the first `put`, which is generation time rather than boot time.
---

## Connection lifecycle

One pool per application instance, reused for the life of the process:

```
Application instance
       │
       ├── MongoDB connection pool
       │
       └── Redis connection
```

Never per request. Both are established once and memoised; nothing opens a connection, queries, and
closes it.

Two details that exist because of cold start specifically:

- **`connectDB` memoises the in-flight promise**, not just a connected flag. A flag only flips after
  the connect resolves, so several requests arriving at a waking instance would each start their own
  connect sequence — 15 retries each. That is the connection storm worth avoiding.
- **The pool is explicitly bounded.** `DB_MAX_POOL_SIZE` defaults to 10; the driver's own default is
  100 _per process_. The limit that binds is the cluster's, not the instance's: three API replicas
  plus a worker at the default would ask Atlas for 400 connections against a shared-tier cap of 500.
  `DB_MIN_POOL_SIZE` is 0, so a sleeping instance holds nothing open.

Raise the pool when a measured queue on it justifies it, not before.

---

## Observability

Cold-start latency looks like random API slowness, so both services log one structured line per
request (`packages/shared/src/request-log.ts`):

```json
{
  "level": "info",
  "message": "request",
  "context": {
    "service": "api",
    "method": "GET",
    "route": "/v1/projects/:id",
    "status": 200,
    "requestId": "req_a1b2c3",
    "durationMs": 412,
    "coldStart": true,
    "uptimeMs": 1180
  }
}
```

How to read it:

| Signature                                               | Meaning                                        |
| ------------------------------------------------------- | ---------------------------------------------- |
| `coldStart: true`, large `durationMs`, small `uptimeMs` | Instance wake-up. Expected on V1.              |
| `coldStart: false`, large `durationMs`                  | A real problem. Not cold start.                |
| `coldStart: true`, large `uptimeMs`                     | The instance was up but idle before this call. |

Two field choices are load-bearing. `route` is the route _pattern_ (`/v1/projects/:id`), never the
concrete path — a path would put project ids in the log and split each endpoint into one line per
resource. And `requestId` is the same id the caller receives in `x-request-id` and in any error
envelope, so a user reporting "request req_a1b2c3 failed" is findable.

**Not measured yet:** per-dependency attribution — how much of `durationMs` was MongoDB versus Redis
versus handler. It needs instrumenting `packages/cache` and mongoose's command events with
request-scoped state, and the cold-start flag answers the question that actually causes confusion.
This is the next step if request logs prove insufficient, and it is recorded here rather than
forgotten.

Do not diagnose slow requests from frontend behaviour. Measure them here.

---

## Scaling path

```
V1                        Growth                      Large hosted traffic
1 Render API              Multiple API instances      Management API
1 Render Worker           Multiple workers                    +
MongoDB Atlas             MongoDB scaling             Dedicated hosted runtime
Upstash Redis             Dedicated Redis                     +
R2 / S3                   CDN / cache                 Multiple runtime instances
                                                              +
                                                      CDN / edge caching
```

Standing rules, so growth is a configuration change rather than a rewrite:

- Never store authoritative application state in process memory.
- Never depend on local filesystem persistence. Artifacts go to a `StorageClient`
  — GridFS or S3, never disk. See [Where artifacts live](#where-artifacts-live).
- Never use in-memory sessions.
- Every instance must be independently capable of serving any request.

### Known single-instance characteristics

Two things behave per-instance today. Neither loses data; both are recorded so nobody has to
rediscover them:

- **Rate limiting** is `@fastify/rate-limit`'s in-process store, so N instances allow roughly N×
  the configured rate. A Redis-backed store would fix the arithmetic at the cost of making the
  limiter depend on Redis, which cuts against Redis being disposable. Worth revisiting when the
  instance count makes the multiple matter.
- **The L1 cache** is per-process, bounded by a TTL. Two instances can serve a value that differs by
  up to that TTL. For content-addressed hosting configs this is structurally safe; for seed records
  the L1 TTL is deliberately shorter to bound the window.

One more, in the API rather than the worker: the version bump on generate is a read-modify-write
(`project.currentVersion += 1` then `save()`), so two concurrent generate requests can target the
same version. The idempotency unique index absorbs the identical-input case, which is the common
one. Closing it properly means a compare-and-swap in the generation route — the hottest path in the
product — so it is recorded here as a known constraint rather than changed under a documentation
phase.

---

## The V1 deployment

```
Vercel
└── Next.js / React            (apps/web)

Render
├── Platform API               (apps/api)
├── Hosted mock runtime        (apps/mock-runtime)
└── Generation Worker          (apps/workers)

MongoDB Atlas
├── Primary database
└── Generated artifacts        (GridFS, bucket 'artifacts')

Upstash
└── Redis + BullMQ

Cloudflare R2 / S3             not provisioned in V1
└── Generated artifacts        (STORAGE_DRIVER=s3 moves them here)
```

Five services in the Phase 6 diagram, five actually running — the mock runtime is its own Render
service so a customer's traffic and the dashboard's never share a process. Artifacts share the
MongoDB cluster rather than sitting in object storage. See [Where artifacts live](#where-artifacts-live) for why,
and for what flipping it involves.

Deliberately absent: Kubernetes, Kafka, a service mesh, microservice decomposition, a distributed
database, multiple queues. The system should stay easy to deploy, debug and operate.

The topology above is described as code in `render.yaml`, which Render reconciles deploys
against. Each service builds through `scripts/render-build.sh` rather than an inline command,
because two things about building this repo on Render are not obvious from the failure they
produce:

- `corepack enable` installs its shims beside the `corepack` binary, which on Render is in the
  read-only `/usr/bin` — it fails with `EROFS ... unlink '/usr/bin/pnpm'`. The script passes
  `--install-directory`, and creates that directory first, which corepack does not do.
- `tsc` across the monorepo exceeds the default heap on a small build container. The script
  raises the ceiling **for the build step only**. Setting `NODE_OPTIONS` as a service
  environment variable instead would also apply it at runtime, where telling V8 it may reach
  4 GB inside a 512 MB container gets the process OOM-killed rather than collected.

Services created in the dashboard before this file existed are not retro-fitted by it: Render
adopts a Blueprint only for services created from one. Either recreate them from `render.yaml`,
or point each existing service's Build Command at `bash ./scripts/render-build.sh <filter>`.
No credential is committed — every secret in the Blueprint is `sync: false`, so Render prompts for
it and keeps the dashboard value. Shared secrets are repeated per service rather than hoisted into
a root-level `envVarGroups`, because Render forbids `sync: false` inside a group; a group would
mean committing the values.

---

## The performance principle

> InstantMockAPI V1 prioritizes predictable application behavior, lightweight API instances,
> reusable database/cache connections, asynchronous generation, and horizontal scalability.
> Cold-start latency from the hosting platform may occur after inactivity, but warm API requests
> should remain fast. Infrastructure should be upgraded when measured traffic and latency justify it
> rather than prematurely introducing distributed-system complexity.

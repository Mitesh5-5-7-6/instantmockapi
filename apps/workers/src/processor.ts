/**
 * Generation-job processor (doc 10).
 *
 * Consumes a GenerationJobPayload and drives the DAG: Level 0 (A/B/C/D) in
 * parallel → Level 1 (E/F, gated on D) → Level 2 (G bundles what exists).
 * Every artifact task transitions the registry (pending → generating →
 * completed | failed), uploads its files to object storage, and mirrors its
 * status into the job's workers[] array — which the API's SSE stream serves.
 *
 * Failures are isolated per artifact (doc 10 §7): the job settles
 * `failed_partial`, never a global failure; completed siblings survive.
 */

import {
  evaluateAutoPublish,
  getErrorMessage,
  logger,
  type ArtifactType,
} from '@instantmockapi/shared';
import {
  Job,
  MockStore,
  Project,
  User,
  Version,
  ensurePublicIdentity,
  hasLiveDeployment,
  publishFields,
  versionArtifactOutcomes,
  type IProject,
} from '@instantmockapi/db';
import {
  createOrResetArtifactRecord,
  getArtifactRecord,
  getArtifactsForVersion,
  transitionArtifactStatus,
} from '@instantmockapi/registry';
import type { GenerationJobPayload } from '@instantmockapi/queue';
import {
  artifactKey,
  bundleKey,
  decodeBundle,
  encodeBundle,
  isBundleKey,
  type StorageClient,
} from '@instantmockapi/storage';
import { generateMockData } from '@instantmockapi/generator-mock-data';
import type { InternalProjectSchema } from '@instantmockapi/ips';
import type { EntityExamples } from '@instantmockapi/generator-docs';
import {
  DEFAULT_PRODUCERS,
  SINGLE_FILE_ARTIFACTS,
  buildExecutionPlan,
  normalizeIps,
  parseExamples,
  workerForArtifact,
  type ArtifactContext,
  type ArtifactProducer,
} from './artifacts.js';

export interface ProcessorDeps {
  storage: StorageClient;
  /** Producer overrides — tests inject failures/spies here. */
  producers?: Partial<Record<ArtifactType, ArtifactProducer>>;
  /** Per-task automatic retry policy (doc 10 §6). */
  retry?: { attempts: number; delayMs: number };
}

// Public base URL of the hosted mock runtime; overridable per-deployment so
// hosted URLs resolve to the actual runtime host (e.g. localhost in dev).
const HOSTED_BASE_URL = process.env['HOSTED_BASE_URL'] ?? 'https://api.instantmockapi.dev/p';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setWorkerEntry(
  jobId: string | undefined,
  artifactType: ArtifactType,
  status: 'queued' | 'running' | 'completed' | 'failed',
  error: string | null = null,
): Promise<void> {
  if (!jobId) {
    return;
  }
  // Atomic positional update — parallel tasks must not race document saves
  await Job.updateOne(
    { _id: jobId, 'workers.artifactType': artifactType },
    { $set: { 'workers.$.status': status, 'workers.$.error': error } },
  );
}

/** Run one artifact task through its full lifecycle. Never throws. */
async function runArtifactTask(
  artifactType: ArtifactType,
  ctx: ArtifactContext,
  payload: GenerationJobPayload,
  deps: Required<Pick<ProcessorDeps, 'storage' | 'retry'>> & {
    producers: Record<ArtifactType, ArtifactProducer>;
  },
): Promise<'completed' | 'failed'> {
  const { projectId, version, jobId } = payload;
  const workerId = workerForArtifact(artifactType);
  const log = logger.child({ projectId, version, artifactType });

  const fail = async (message: string): Promise<'failed'> => {
    await transitionArtifactStatus(projectId, artifactType, version, 'failed', {
      errorMessage: message,
      workerId,
    });
    await setWorkerEntry(jobId, artifactType, 'failed', message);
    log.error('Artifact task failed', { error: message });
    return 'failed';
  };

  try {
    await setWorkerEntry(jobId, artifactType, 'running');

    // Ensure a registry row exists, then enter 'generating'. A row stuck in
    // 'generating' (crashed prior attempt) is taken over as-is.
    const existing = await getArtifactRecord(projectId, artifactType, version);
    if (!existing.ok || !existing.value) {
      const created = await createOrResetArtifactRecord(projectId, artifactType, version);
      if (!created.ok) {
        return fail(created.error.message);
      }
    }
    if (!existing.ok || existing.value?.status !== 'generating') {
      const entered = await transitionArtifactStatus(
        projectId,
        artifactType,
        version,
        'generating',
        {
          workerId,
        },
      );
      if (!entered.ok) {
        return fail(entered.error.message);
      }
    }

    // Invoke the pure generator with automatic retries (doc 10 §6)
    const producer = deps.producers[artifactType];
    let produced: Record<string, string> | Uint8Array | null = null;
    let lastError = 'Generation failed';
    for (let attempt = 1; attempt <= deps.retry.attempts; attempt++) {
      try {
        produced = await producer(ctx);
        break;
      } catch (error) {
        lastError = getErrorMessage(error);
        log.warn('Artifact attempt failed', { attempt, error: lastError });
        if (attempt < deps.retry.attempts) {
          await sleep(deps.retry.delayMs * attempt);
        }
      }
    }
    if (produced === null) {
      return fail(lastError);
    }

    // Upload: binary/single-file artifacts store the file itself; multi-file
    // artifacts store a JSON bundle (see packages/storage keys.ts)
    const single = SINGLE_FILE_ARTIFACTS[artifactType];
    let storageRef: string;
    if (produced instanceof Uint8Array) {
      storageRef = artifactKey(projectId, version, artifactType, `${artifactType}.zip`);
      await deps.storage.put(storageRef, produced, single?.contentType ?? 'application/zip');
    } else if (single) {
      const [filename, content] = Object.entries(produced)[0] ?? [`${artifactType}.json`, '{}'];
      storageRef = artifactKey(projectId, version, artifactType, filename);
      await deps.storage.put(storageRef, content, single.contentType);
    } else {
      storageRef = bundleKey(projectId, version, artifactType);
      await deps.storage.put(storageRef, encodeBundle(produced), 'application/json');
    }

    const completed = await transitionArtifactStatus(
      projectId,
      artifactType,
      version,
      'completed',
      {
        storageRef,
        workerId,
      },
    );
    if (!completed.ok) {
      return fail(completed.error.message);
    }
    await setWorkerEntry(jobId, artifactType, 'completed');
    log.info('Artifact completed', { storageRef });
    return 'completed';
  } catch (error) {
    return fail(getErrorMessage(error));
  }
}

/** Seed the hosted mock stores from Worker D's records (doc 09 §4, Worker F). */
async function seedMockStores(project: IProject, examples: EntityExamples): Promise<void> {
  for (const [entity, records] of Object.entries(examples)) {
    await MockStore.findOneAndUpdate(
      { projectId: project._id, entity },
      { $set: { records } },
      { upsert: true },
    );
  }
}

/** Collect every completed artifact's files for the export bundle (doc 10 §4). */
async function collectBundle(
  payload: GenerationJobPayload,
  storage: StorageClient,
): Promise<{ files: Record<string, string | Uint8Array>; included: string[] }> {
  const files: Record<string, string | Uint8Array> = {};
  const included: string[] = [];

  const artifacts = await getArtifactsForVersion(payload.projectId, payload.version);
  if (!artifacts.ok) {
    return { files, included };
  }

  for (const artifact of artifacts.value) {
    if (
      artifact.artifactType === 'export_zip' ||
      artifact.status !== 'completed' ||
      !artifact.storageRef
    ) {
      continue;
    }
    const object = await storage.get(artifact.storageRef);
    if (!object) {
      continue;
    }
    if (isBundleKey(artifact.storageRef)) {
      const bundle = decodeBundle(object.body);
      for (const [filename, content] of Object.entries(bundle.files)) {
        files[`${artifact.artifactType}/${filename}`] = content;
      }
    } else {
      const filename = artifact.storageRef.split('/').pop() ?? artifact.artifactType;
      files[`${artifact.artifactType}/${filename}`] = object.body;
    }
    included.push(artifact.artifactType);
  }

  return { files, included: included.sort() };
}

/**
 * Record a job whose retries are spent (Phase 6 §8).
 *
 * Wired to `createGenerationWorker`'s `onExhausted`. Everything inside
 * `processGenerationJob` that fails *per artifact* already settles itself —
 * `runArtifactTask` never throws by design, so one bad artifact does not fail
 * the batch. What is left is the outer work: loading the snapshot, seeding mock
 * stores, collecting the bundle, settling. A throw there used to leave the Mongo
 * document on `running` permanently, because the settle path is the thing that
 * did not run.
 *
 * The consequence was not a wrong status but a hanging one: `isTerminal` in the
 * jobs route never fires, so the client's SSE stream waits out its five-minute
 * cap and the UI shows a job still in progress that no worker will ever touch
 * again.
 *
 * `failed_partial` rather than a hard `failed` because `IJob['status']` has no
 * such value — the four states are `queued | running | completed |
 * failed_partial` — and inventing a fifth would touch every consumer of the
 * enum. The `error` on each worker entry is what says it failed outright.
 */
export async function settleExhaustedJob(
  payload: GenerationJobPayload,
  error: Error,
): Promise<void> {
  if (!payload.jobId) {
    return;
  }
  logger
    .child({ projectId: payload.projectId, version: payload.version })
    .error('Generation job exhausted its retries; settling as failed', { error: error.message });
  await Job.updateOne(
    // `status: { $ne: 'completed' }` so a job that succeeded on a later attempt
    // — or was settled by the handler before the throw — is never walked back.
    { _id: payload.jobId, status: { $ne: 'completed' } },
    {
      $set: {
        status: 'failed_partial',
        completedAt: new Date(),
        'workers.$[pending].status': 'failed',
        'workers.$[pending].error': error.message,
      },
    },
    {
      // Only the entries that never reached a terminal state. A worker that
      // completed before the outer throw keeps its result, which is what makes
      // the settled document an honest account of what was produced.
      arrayFilters: [{ 'pending.status': { $nin: ['completed', 'failed'] } }],
    },
  );
}

export async function processGenerationJob(
  payload: GenerationJobPayload,
  options: ProcessorDeps,
): Promise<void> {
  const deps = {
    storage: options.storage,
    retry: options.retry ?? { attempts: 3, delayMs: 1000 },
    producers: { ...DEFAULT_PRODUCERS, ...options.producers },
  };
  const log = logger.child({ projectId: payload.projectId, version: payload.version });

  const project = await Project.findById(payload.projectId);
  if (!project) {
    log.error('Project not found; abandoning job');
    if (payload.jobId) {
      await Job.updateOne(
        { _id: payload.jobId },
        {
          $set: {
            status: 'failed_partial',
            completedAt: new Date(),
            'workers.$[].status': 'failed',
            'workers.$[].error': 'Project not found',
          },
        },
      );
    }
    return;
  }

  // Generators run against the immutable version snapshot (doc 09 §7) — but
  // addressing comes from the LIVE project document, never the snapshot: a slug
  // edited after the snapshot was taken must not resurrect the old path.
  const snapshot = await Version.findOne({ projectId: project._id, version: payload.version });
  const ips: InternalProjectSchema = normalizeIps({
    ...(snapshot?.ipsSnapshot ?? project.ips),
    generationConfig: snapshot?.configSnapshot ?? project.generationConfig,
    kind: project.kind ?? 'project',
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  });

  if (payload.jobId) {
    await Job.updateOne({ _id: payload.jobId, status: 'queued' }, { $set: { status: 'running' } });
  }

  // Worker D's data is produced once per job: it is the mock_data artifact,
  // E's examples, and F's seed. Seeded with the version for reproducibility.
  const mockFiles = generateMockData(ips, payload.version);
  const examples = parseExamples(mockFiles);

  const ctx: ArtifactContext = {
    ips,
    mockFiles,
    examples,
    bundleFiles: {},
    includedArtifacts: [],
    baseUrl: HOSTED_BASE_URL,
  };
  const plan = buildExecutionPlan(payload.requestedArtifacts);
  const outcomes = new Map<ArtifactType, 'completed' | 'failed'>();

  // Level 0: A/B/C/D fan out in parallel
  await Promise.all(
    plan.level0.map(async (artifactType) => {
      outcomes.set(artifactType, await runArtifactTask(artifactType, ctx, payload, deps));
    }),
  );

  // Level 1: E/F wait on D. If D was requested in this job and failed, its
  // dependents are skipped (doc 10 §4); when D isn't part of the job the
  // in-memory regeneration above supplies their inputs.
  const mockDataFailed =
    plan.level0.includes('mock_data') && outcomes.get('mock_data') === 'failed';
  if (mockDataFailed) {
    for (const artifactType of plan.level1) {
      outcomes.set(artifactType, 'failed');
      await setWorkerEntry(
        payload.jobId,
        artifactType,
        'failed',
        'Dependency mock_data failed to generate',
      );
    }
  } else {
    await Promise.all(
      plan.level1.map(async (artifactType) => {
        outcomes.set(artifactType, await runArtifactTask(artifactType, ctx, payload, deps));
      }),
    );
  }

  // Hosting went live: seed the mock stores from D's records
  if (outcomes.get('hosted_api') === 'completed') {
    await seedMockStores(project, examples);
  }

  // Level 2: G bundles whatever exists for this version
  if (plan.level2.length > 0) {
    const bundle = await collectBundle(payload, deps.storage);
    ctx.bundleFiles = bundle.files;
    ctx.includedArtifacts = bundle.included;
    for (const artifactType of plan.level2) {
      outcomes.set(artifactType, await runArtifactTask(artifactType, ctx, payload, deps));
    }
  }

  await settle(payload, project, outcomes, log);
}

async function settle(
  payload: GenerationJobPayload,
  project: IProject,
  outcomes: Map<ArtifactType, 'completed' | 'failed'>,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  // Job status derives from ALL worker entries (a partial retry job only
  // carries its own workers; the job doc reflects the full picture)
  let jobStatus: 'completed' | 'failed_partial' = 'completed';
  if (payload.jobId) {
    const job = await Job.findById(payload.jobId);
    if (job) {
      jobStatus = job.workers.every((w) => w.status === 'completed')
        ? 'completed'
        : 'failed_partial';
      await Job.updateOne(
        { _id: job._id },
        { $set: { status: jobStatus, completedAt: new Date() } },
      );
    }
  } else {
    jobStatus = [...outcomes.values()].every((o) => o === 'completed')
      ? 'completed'
      : 'failed_partial';
  }

  // ── Addressing, which is NOT deployment ──
  //
  // `publicId`/`slug` are properties of the project: versionless, idempotent,
  // and needed before publish so the UI can say where a READY version *will*
  // serve. The hosted URL itself is not minted here — see the publish branch.
  const anyCompleted = [...outcomes.values()].some((o) => o === 'completed');
  if (anyCompleted) {
    await ensurePublicIdentity(project);
  }

  // ── Project status ──
  //
  // `status` is read by the mock runtime as a live-or-not gate, so generation
  // must not set it to 'active': that is a claim that something is being served,
  // and only publishing can make it true. A zod-only job on a fresh project used
  // to leave `status: 'active'` with no live API at all.
  //
  // The 'expired' case is load-bearing too. `generate-again` requires
  // `status === 'expired'`, so flipping an expired project to 'active' on a
  // failed re-run permanently locked it out of the only route that could fix it.
  if (project.status === 'generating') {
    project.status = hasLiveDeployment(project) ? 'active' : 'draft';
  }

  // ── Promotion ──
  //
  // Deliberately NOT `outcomes.get(...)`. A job settles with whatever IT
  // touched, and a partial regenerate touches a subset — so "what this job
  // produced" cannot answer "can this version serve traffic". The registry is
  // read for the whole version instead, which is what makes affected-artifacts-
  // only regeneration safe: regenerate three of nine artifacts and readiness is
  // still judged on all nine.
  //
  //   job settles → artifact statuses → version readiness → policy → pointer
  //
  // The policy lives in packages/shared/src/promotion.ts, so the rule
  // "hosted_api is the only artifact the runtime reads, therefore a failed
  // OpenAPI degrades a version rather than blocking it" is stated once and is
  // testable without spinning up a worker.
  const versionOutcomes = await versionArtifactOutcomes(project._id, payload.version);
  const decision = evaluateAutoPublish({
    candidate: payload.version,
    published: project.publishedVersion,
    // `hosted.url`, NOT `publishedVersion != null`: `pinPublishedVersion` stamps
    // that field speculatively on the first edit, so a project whose first
    // action was a partial regenerate has `publishedVersion = 1` pointing at a
    // version with no artifacts. Keying the exception on it would withhold the
    // first publish from exactly the user it exists for.
    live: hasLiveDeployment(project),
    outcomes: versionOutcomes,
  });

  log.info(decision.promote ? 'Publishing first version' : 'Not publishing', {
    version: payload.version,
    livePublished: project.publishedVersion ?? null,
    reason: decision.reason,
    blocking: decision.readiness.blocking,
    degraded: decision.readiness.degraded,
    staleDataRisk: decision.readiness.staleDataRisk,
  });

  /*
   * The non-publish changes go first, then the publish under a compare-and-swap.
   *
   * The order is load-bearing. `publishFields` sets `status: 'active'` and the
   * walk-back above may have just set `'draft'`, so whichever writes last wins
   * — and it has to be the publish. Saving first also means a *lost* swap
   * leaves the project exactly as an unpublished generation should: status
   * walked back, addressing minted, pointer untouched.
   */
  const pointerAsRead = project.publishedVersion ?? null;
  await project.save();

  if (decision.promote) {
    // Generation does NOT publish (Phase 2 §1). The single exception is a
    // project with nothing live: onboarding must end on a working URL, and
    // there is no live runtime to disturb. Every other version stops at READY
    // and waits for `POST /versions/:version/publish`.
    //
    // The invariant this preserves either way: a failed generation can never
    // destroy or temporarily disable the currently live version.
    const owner = await User.findById(project.ownerId);

    /*
     * Compare-and-swap on the pointer, mirroring the publish route.
     *
     * `evaluateAutoPublish` decided from `publishedVersion` as it was read at
     * the top of this function, and an unconditional write applies that
     * decision however stale it has become. Two workers settling out of order
     * could each pass the policy's never-move-backwards guard against their own
     * stale read, and the later write would win regardless of which version it
     * named — so the pointer could end up on a version neither of them
     * validated as ready.
     *
     * `apps/api/src/routes/versions.ts` already guards the identical write and
     * says why; the worker did not, and that asymmetry is what Phase 6 §8's
     * "supports multiple workers" closes. A filter value of `null` matches a
     * missing field too, which is the common first-publish case.
     */
    const promoted = await Project.findOneAndUpdate(
      { _id: project._id, publishedVersion: pointerAsRead },
      {
        $set: publishFields(project, payload.version, {
          baseUrl: HOSTED_BASE_URL,
          plan: owner?.plan ?? 'free',
        }),
      },
      { new: true },
    );

    if (!promoted) {
      // Not an error: another writer published while this job was generating,
      // and its decision was made against artifact rows this one cannot see.
      // Leaving the pointer alone is the safe outcome, and the log line is what
      // makes an unexpectedly-unpublished version explainable.
      log.warn('Skipped auto-publish: the published pointer moved during generation', {
        version: payload.version,
        pointerAsRead,
      });
    } else {
      // The publish event, which nothing else records: "was live and is not any
      // more" leaves no trace in the artifact rows, so the history list and the
      // derived SUPERSEDED status both need this stamped.
      await Version.updateOne(
        { projectId: project._id, version: payload.version, publishedAt: null },
        { $set: { publishedAt: new Date() } },
      );
    }
  }

  log.info('Generation job settled', {
    jobStatus,
    outcomes: Object.fromEntries(outcomes),
  });
}

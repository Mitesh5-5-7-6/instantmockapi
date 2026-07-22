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

import { getErrorMessage, logger, type ArtifactType } from '@instantmockapi/shared';
import { calculateExpiresAt } from '@instantmockapi/config';
import { Job, MockStore, Project, User, Version, type IProject } from '@instantmockapi/db';
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

  // Generators run against the immutable version snapshot (doc 09 §7)
  const snapshot = await Version.findOne({ projectId: project._id, version: payload.version });
  const ips: InternalProjectSchema = normalizeIps({
    ...(snapshot?.ipsSnapshot ?? project.ips),
    generationConfig: snapshot?.configSnapshot ?? project.generationConfig,
  });

  if (payload.jobId) {
    await Job.updateOne({ _id: payload.jobId, status: 'queued' }, { $set: { status: 'running' } });
  }

  // Worker D's data is produced once per job: it is the mock_data artifact,
  // E's examples, and F's seed. Seeded with the version for reproducibility.
  const mockFiles = generateMockData(ips, payload.version);
  const examples = parseExamples(mockFiles);

  const ctx: ArtifactContext = { ips, mockFiles, examples, bundleFiles: {}, includedArtifacts: [] };
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

  // Project status: anything completed → 'active'; hosting success also
  // stamps the hosted URL + plan-based expiry (doc 07, doc 13 §2 plan gates)
  const anyCompleted = [...outcomes.values()].some((o) => o === 'completed');
  if (anyCompleted) {
    project.status = 'active';
  } else if (project.status === 'generating') {
    project.status = 'draft';
  }

  if (outcomes.get('hosted_api') === 'completed') {
    const owner = await User.findById(project.ownerId);
    project.hosted = {
      url: `${HOSTED_BASE_URL}/${String(project._id)}`,
      expiresAt: calculateExpiresAt(owner?.plan ?? 'free'),
    };
  }
  await project.save();

  log.info('Generation job settled', {
    jobStatus,
    outcomes: Object.fromEntries(outcomes),
  });
}

import { Queue, QueueOptions, Job, Worker, type WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import crypto from 'crypto';
import { getErrorMessage, logger } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import type { GenerationConfig } from '@instantmockapi/ips';

export interface GenerationJobPayload {
  projectId: string;
  version: number;
  type: 'full' | 'partial';
  requestedArtifacts: string[];
  /** Mongo `jobs` document id — lets the worker update job/worker statuses. */
  jobId?: string;
}

let redisInstance: Redis | null = null;
let jobQueueInstance: Queue | null = null;
let aiQueueInstance: Queue | null = null;

/**
 * AI proposals get their own queue, not a job type on `generation-jobs`.
 *
 * A Gemini call takes 10–80 s; sharing the generation queue would let a burst
 * of prompts stall every project's generation behind them, and the two need
 * different retry policies.
 */
export const AI_QUEUE_NAME = 'ai-proposal-jobs';

export interface AiProposalJobPayload {
  proposalId: string;
}

export const QUEUE_NAME = 'generation-jobs';

/**
 * Returns a shared connection to Redis.
 */
export function getRedisConnection(): Redis {
  if (redisInstance) {
    return redisInstance;
  }

  const config = loadEnvConfig();
  logger.info('Initializing Redis connection for Queue', { redisUrl: config.redisUrl });

  redisInstance = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
  });

  redisInstance.on('error', (err) => {
    logger.error('Queue Redis connection error', { error: err.message });
  });

  return redisInstance;
}

/**
 * Returns the BullMQ Queue instance.
 */
export function getJobQueue(): Queue {
  if (jobQueueInstance) {
    return jobQueueInstance;
  }

  const redis = getRedisConnection();
  const queueOptions: QueueOptions = {
    connection: redis,
    defaultJobOptions: {
      attempts: 3, // Retry policy (doc 07 §2)
      backoff: {
        type: 'exponential',
        delay: 5000, // starting backoff delay 5s
      },
      removeOnComplete: true, // clean up completed jobs from Redis
      removeOnFail: false, // keep failed jobs for debugging / manual retry
    },
  };

  jobQueueInstance = new Queue(QUEUE_NAME, queueOptions);
  return jobQueueInstance;
}

export function getAiProposalQueue(): Queue {
  if (aiQueueInstance) {
    return aiQueueInstance;
  }
  aiQueueInstance = new Queue(AI_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // Only transient provider errors throw (rate limit, 5xx, timeout); final
      // failures are written to Mongo by the handler, which then returns.
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    },
  });
  return aiQueueInstance;
}

/**
 * Job id `${proposalId}-${run}`: the same run enqueued twice dedupes (a double
 * submit), and a retry — a new run — is a new job even though the failed one is
 * still in Redis. No colon: BullMQ reserves it in custom ids.
 */
export async function enqueueAiProposalJob(
  proposalId: string,
  run: number,
): Promise<Job<AiProposalJobPayload>> {
  logger.info('Enqueuing AI proposal job', { proposalId, run });
  return (await getAiProposalQueue().add(
    AI_QUEUE_NAME,
    { proposalId },
    { jobId: `${proposalId}-${run}` },
  )) as Job<AiProposalJobPayload>;
}

/**
 * Closes the Queue connection.
 */
export async function closeQueue(): Promise<void> {
  if (jobQueueInstance) {
    await jobQueueInstance.close();
    jobQueueInstance = null;
  }
  if (aiQueueInstance) {
    await aiQueueInstance.close();
    aiQueueInstance = null;
  }
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}

/**
 * Computes a deterministic idempotency key for a job.
 * hash(projectId, version, config) -> doc 07 §2
 *
 * `requestedArtifacts` (order-insensitive) participates in the hash when
 * provided, so a partial regenerate at the same version/config does not
 * collide with — and get deduplicated into — an earlier full job.
 */
export function generateIdempotencyKey(
  projectId: string,
  version: number,
  config: GenerationConfig,
  requestedArtifacts?: string[],
  /**
   * The schema being generated from.
   *
   * Optional for compatibility with existing callers, but supplying it is what
   * makes the key describe the actual INPUTS rather than just their address. A
   * restore rewrites `ips`, and a Phase 1 draft commit will too; without the
   * schema in the hash, two generations of genuinely different definitions can
   * collide and the second silently dedupes into the first — generating the
   * wrong thing and reporting success.
   */
  schema?: unknown,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(projectId);
  hash.update(version.toString());
  hash.update(JSON.stringify(config));
  if (requestedArtifacts && requestedArtifacts.length > 0) {
    hash.update(JSON.stringify([...requestedArtifacts].sort()));
  }
  if (schema !== undefined) {
    // Not sorted or canonicalised: an IPS is authored in a meaningful order
    // (field order shows up in generated types), so a reordering IS a different
    // input and should produce a different key.
    hash.update(JSON.stringify(schema));
  }
  return hash.digest('hex');
}

/**
 * Enqueues a generation job into BullMQ.
 * Respects idempotency keys and retry policies.
 */
export async function enqueueGenerationJob(
  projectId: string,
  version: number,
  type: 'full' | 'partial',
  requestedArtifacts: string[],
  idempotencyKey: string,
  jobId?: string,
): Promise<Job<GenerationJobPayload>> {
  const queue = getJobQueue();
  const payload: GenerationJobPayload = {
    projectId,
    version,
    type,
    requestedArtifacts,
    ...(jobId !== undefined ? { jobId } : {}),
  };

  logger.info('Enqueuing generation job', {
    projectId,
    version,
    type,
    idempotencyKey,
  });

  // The idempotencyKey doubles as the BullMQ job id to enforce dedup. But
  // `queue.add` is a silent no-op when that id already exists in ANY state --
  // and `removeOnFail: false` keeps failed jobs forever. Without this sweep a
  // single failure permanently blocks every future job for the same
  // project+version+config: the API still returns 202 and Mongo still says
  // "queued", but nothing is ever handed to a worker.
  const existing = await queue.getJob(idempotencyKey);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') {
      logger.info('Clearing settled job to allow re-enqueue', { idempotencyKey, state });
      await existing.remove();
    } else {
      logger.info('Generation job already in flight; reusing', { idempotencyKey, state });
      return existing as Job<GenerationJobPayload>;
    }
  }

  const job = await queue.add(QUEUE_NAME, payload, {
    jobId: idempotencyKey,
  });

  return job;
}

/**
 * Consumer side: a BullMQ Worker bound to the generation queue.
 * `apps/workers` supplies the handler; concurrency is the per-replica infra
 * limit (doc 10 §5), independent of plan concurrency.
 */
export interface GenerationWorkerOptions {
  concurrency?: number;
  /**
   * Called once a job has failed its **final** attempt (Phase 6 §8).
   *
   * BullMQ's retry policy and the Mongo `jobs` document are two separate
   * records of the same job, and only the queue knows when the retries are
   * spent. Without this hook a handler that throws leaves the Mongo document on
   * `running` forever: the settle path inside the handler never runs, so
   * `isTerminal` never fires and the client's progress stream waits out its
   * five-minute cap on a job that is not coming back.
   *
   * A callback rather than a direct write, so this package stays free of
   * `@instantmockapi/db` — the queue owns "when the attempts are spent", the
   * worker app owns "what a failed job looks like in Mongo".
   *
   * Only on the final attempt: settling earlier would show a user a failure
   * that the next attempt may well fix.
   */
  onExhausted?: (payload: GenerationJobPayload, error: Error) => Promise<void>;
}

interface WorkerFactoryOptions<T> {
  concurrency?: number;
  onExhausted?: (payload: T, error: Error) => Promise<void>;
}

/**
 * Shared by every queue so they all get the same polling budget and the same
 * "final attempt spent" hook. `describe` supplies the identifiers that go on the
 * "picked up" log line (e.g. `projectId` for generation jobs).
 */
function buildWorker<T>(
  queueName: string,
  label: string,
  describe: (payload: T) => Record<string, unknown>,
  handler: (payload: T) => Promise<void>,
  options: WorkerFactoryOptions<T>,
): Worker<T> {
  const config = loadEnvConfig();

  // Idle polling — not cache traffic — is what actually consumes a free Redis
  // plan's monthly command budget. A BullMQ worker sitting on an empty queue
  // issues one blocking BZPOPMIN every `drainDelay` seconds plus one stalled
  // sweep every `stalledInterval` ms, forever. At the library defaults (5s /
  // 30s) that is ~20K commands/day = ~605K/month for a worker that has done
  // no work at all, which alone exceeds the 500K/month free tier.
  //
  // Raising drainDelay costs nothing in pickup latency: `Queue.add` writes the
  // marker key that wakes the blocked BZPOPMIN immediately, so drainDelay is
  // only the timeout on an otherwise-idle wait, never a poll interval that a
  // new job has to wait out.
  const workerOptions: WorkerOptions = {
    connection: getRedisConnection(),
    concurrency: options.concurrency ?? 2,
    drainDelay: config.queueDrainDelaySeconds,
    // The one real trade-off: a job orphaned by a hard worker crash is
    // recovered after up to this interval instead of 30s. It is a recovery
    // path, not the happy path — retries and idempotency still apply.
    stalledInterval: config.queueStalledIntervalMs,
  };

  const worker = new Worker<T>(
    queueName,
    async (job) => {
      logger.info(`${label} job picked up`, { jobId: job.id, ...describe(job.data) });
      await handler(job.data);
    },
    workerOptions,
  );

  worker.on('failed', (job, error) => {
    logger.error(`${label} job failed`, { jobId: job?.id, error: error.message });
    if (!job) {
      return;
    }
    /*
     * `attemptsMade` is already incremented for the attempt that just failed,
     * so equality means the last one is spent. Defaulting `attempts` to 1 makes
     * a job queued without a retry policy exhausted on its first failure, which
     * is the honest reading.
     */
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }
    const settle = options.onExhausted;
    if (!settle) {
      return;
    }
    // Detached: this runs inside an event handler, so a rejection here must not
    // become an unhandled rejection that takes the worker process down.
    void settle(job.data, error).catch((cause: unknown) => {
      logger.error(`Failed to record an exhausted ${label.toLowerCase()} job`, {
        jobId: job.id,
        error: getErrorMessage(cause),
      });
    });
  });

  return worker;
}

export function createGenerationWorker(
  handler: (payload: GenerationJobPayload) => Promise<void>,
  options: GenerationWorkerOptions = {},
): Worker<GenerationJobPayload> {
  return buildWorker(
    QUEUE_NAME,
    'Generation',
    (payload) => ({ projectId: payload.projectId }),
    handler,
    options,
  );
}

export function createAiProposalWorker(
  handler: (payload: AiProposalJobPayload) => Promise<void>,
  options: WorkerFactoryOptions<AiProposalJobPayload> = {},
): Worker<AiProposalJobPayload> {
  return buildWorker(
    AI_QUEUE_NAME,
    'AI proposal',
    (payload) => ({ proposalId: payload.proposalId }),
    handler,
    options,
  );
}

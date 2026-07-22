import { Queue, QueueOptions, Job, Worker, type WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import crypto from 'crypto';
import { logger } from '@instantmockapi/shared';
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

/**
 * Closes the Queue connection.
 */
export async function closeQueue(): Promise<void> {
  if (jobQueueInstance) {
    await jobQueueInstance.close();
    jobQueueInstance = null;
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
): string {
  const hash = crypto.createHash('sha256');
  hash.update(projectId);
  hash.update(version.toString());
  hash.update(JSON.stringify(config));
  if (requestedArtifacts && requestedArtifacts.length > 0) {
    hash.update(JSON.stringify([...requestedArtifacts].sort()));
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
export function createGenerationWorker(
  handler: (payload: GenerationJobPayload) => Promise<void>,
  options: { concurrency?: number } = {},
): Worker<GenerationJobPayload> {
  const workerOptions: WorkerOptions = {
    connection: getRedisConnection(),
    concurrency: options.concurrency ?? 2,
  };

  const worker = new Worker<GenerationJobPayload>(
    QUEUE_NAME,
    async (job) => {
      logger.info('Generation job picked up', { jobId: job.id, projectId: job.data.projectId });
      await handler(job.data);
    },
    workerOptions,
  );

  worker.on('failed', (job, error) => {
    logger.error('Generation job failed', { jobId: job?.id, error: error.message });
  });

  return worker;
}

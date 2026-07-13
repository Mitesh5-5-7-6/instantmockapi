import { Queue, QueueOptions, Job } from 'bullmq';
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
}

let redisInstance: Redis | null = null;
let jobQueueInstance: Queue | null = null;

const QUEUE_NAME = 'generation-jobs';

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
    connection: redis as any,
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
 */
export function generateIdempotencyKey(
  projectId: string,
  version: number,
  config: GenerationConfig,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(projectId);
  hash.update(version.toString());
  hash.update(JSON.stringify(config));
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
): Promise<Job<GenerationJobPayload>> {
  const queue = getJobQueue();
  const payload: GenerationJobPayload = {
    projectId,
    version,
    type,
    requestedArtifacts,
  };

  logger.info('Enqueuing generation job', {
    projectId,
    version,
    type,
    idempotencyKey,
  });

  // Use the idempotencyKey as the job ID in BullMQ to enforce deduplication/idempotency
  const job = await queue.add(QUEUE_NAME, payload, {
    jobId: idempotencyKey,
  });

  return job;
}

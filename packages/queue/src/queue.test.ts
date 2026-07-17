import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GenerationConfig } from '@instantmockapi/ips';

// In-memory stand-ins for BullMQ/Redis. `queue.add` mirrors BullMQ's jobId
// semantics: adding with an existing jobId returns the existing job instead
// of creating a new one — the mechanism our idempotency relies on.
const state = vi.hoisted(() => ({
  jobs: new Map<string, { id: string; name: string; data: unknown; opts: unknown }>(),
  queueCtorOpts: [] as unknown[],
  redisCtorArgs: [] as unknown[],
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(
      public name: string,
      opts: unknown,
    ) {
      state.queueCtorOpts.push(opts);
    }
    async add(name: string, data: unknown, opts?: { jobId?: string }) {
      const jobId = opts?.jobId ?? `auto-${state.jobs.size + 1}`;
      const existing = state.jobs.get(jobId);
      if (existing) {
        return existing;
      }
      const job = { id: jobId, name, data, opts };
      state.jobs.set(jobId, job);
      return job;
    }
    async close() {}
  }
  class Worker {
    constructor(
      public name: string,
      public processor: unknown,
      public opts: unknown,
    ) {}
    on() {
      return this;
    }
    async close() {}
  }
  return { Queue, Worker };
});

vi.mock('ioredis', () => {
  class Redis {
    constructor(...args: unknown[]) {
      state.redisCtorArgs.push(args);
    }
    on() {
      return this;
    }
    async quit() {}
  }
  return { default: Redis };
});

import {
  generateIdempotencyKey,
  enqueueGenerationJob,
  getJobQueue,
  closeQueue,
  type GenerationJobPayload,
} from './queue.js';

const config: GenerationConfig = {
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST'],
  mockRecords: 25,
};

const PROJECT_ID = '507f1f77bcf86cd799439011';

beforeEach(async () => {
  await closeQueue();
  state.jobs.clear();
  state.queueCtorOpts.length = 0;
});

describe('generateIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = generateIdempotencyKey(PROJECT_ID, 1, config);
    const b = generateIdempotencyKey(PROJECT_ID, 1, { ...config });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when projectId, version, or config changes', () => {
    const base = generateIdempotencyKey(PROJECT_ID, 1, config);
    expect(generateIdempotencyKey('507f1f77bcf86cd799439012', 1, config)).not.toBe(base);
    expect(generateIdempotencyKey(PROJECT_ID, 2, config)).not.toBe(base);
    expect(generateIdempotencyKey(PROJECT_ID, 1, { ...config, mockRecords: 50 })).not.toBe(base);
  });

  it('distinguishes jobs by requested artifacts, order-insensitively', () => {
    const full = generateIdempotencyKey(PROJECT_ID, 1, config, ['zod', 'yup', 'typescript']);
    const partial = generateIdempotencyKey(PROJECT_ID, 1, config, ['zod']);
    const reordered = generateIdempotencyKey(PROJECT_ID, 1, config, ['yup', 'typescript', 'zod']);
    expect(partial).not.toBe(full);
    expect(reordered).toBe(full);
    expect(generateIdempotencyKey(PROJECT_ID, 1, config)).not.toBe(full);
  });
});

describe('enqueueGenerationJob', () => {
  it('uses the idempotency key as the BullMQ jobId with the full payload', async () => {
    const key = generateIdempotencyKey(PROJECT_ID, 1, config);
    const job = await enqueueGenerationJob(PROJECT_ID, 1, 'full', ['zod', 'typescript'], key);

    expect(job.id).toBe(key);
    const payload = job.data as GenerationJobPayload;
    expect(payload).toEqual({
      projectId: PROJECT_ID,
      version: 1,
      type: 'full',
      requestedArtifacts: ['zod', 'typescript'],
    });
  });

  it('deduplicates: enqueueing the same key twice returns the existing job', async () => {
    const key = generateIdempotencyKey(PROJECT_ID, 1, config);
    const first = await enqueueGenerationJob(PROJECT_ID, 1, 'full', ['zod'], key);
    const second = await enqueueGenerationJob(PROJECT_ID, 1, 'full', ['zod'], key);

    expect(second.id).toBe(first.id);
    expect(state.jobs.size).toBe(1);
  });

  it('creates distinct jobs for distinct keys', async () => {
    const keyV1 = generateIdempotencyKey(PROJECT_ID, 1, config);
    const keyV2 = generateIdempotencyKey(PROJECT_ID, 2, config);
    await enqueueGenerationJob(PROJECT_ID, 1, 'full', ['zod'], keyV1);
    await enqueueGenerationJob(PROJECT_ID, 2, 'full', ['zod'], keyV2);

    expect(state.jobs.size).toBe(2);
  });
});

describe('getJobQueue', () => {
  it('configures the documented retry policy (3 attempts, exponential backoff from 5s)', () => {
    getJobQueue();
    expect(state.queueCtorOpts).toHaveLength(1);
    const opts = state.queueCtorOpts[0] as {
      defaultJobOptions: {
        attempts: number;
        backoff: { type: string; delay: number };
        removeOnComplete: boolean;
        removeOnFail: boolean;
      };
    };
    expect(opts.defaultJobOptions.attempts).toBe(3);
    expect(opts.defaultJobOptions.backoff).toEqual({ type: 'exponential', delay: 5000 });
    expect(opts.defaultJobOptions.removeOnComplete).toBe(true);
    expect(opts.defaultJobOptions.removeOnFail).toBe(false);
  });

  it('is a singleton until closeQueue resets it', async () => {
    const a = getJobQueue();
    const b = getJobQueue();
    expect(b).toBe(a);
    await closeQueue();
    const c = getJobQueue();
    expect(c).not.toBe(a);
  });
});

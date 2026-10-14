import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  jobs: new Map<string, { id: string; name: string; data: unknown }>(),
  queues: [] as Array<{ name: string; opts: { defaultJobOptions?: Record<string, unknown> } }>,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(
      public name: string,
      opts: { defaultJobOptions?: Record<string, unknown> },
    ) {
      state.queues.push({ name, opts });
    }
    async add(name: string, data: unknown, opts?: { jobId?: string }) {
      const id = opts?.jobId ?? `auto-${state.jobs.size + 1}`;
      const existing = state.jobs.get(id);
      if (existing) return existing;
      const job = { id, name, data };
      state.jobs.set(id, job);
      return job;
    }
    async close() {}
  }
  class Worker {
    on() {}
  }
  return { Queue, Worker };
});

vi.mock('ioredis', () => ({
  default: class {
    on() {}
    async quit() {}
  },
}));

import { AI_QUEUE_NAME, closeQueue, enqueueAiProposalJob, getAiProposalQueue } from './queue.js';

beforeEach(async () => {
  state.jobs.clear();
  state.queues.length = 0;
  await closeQueue();
});

describe('AI proposal queue', () => {
  it('is its own queue, separate from generation jobs', () => {
    getAiProposalQueue();
    expect(state.queues.map((q) => q.name)).toContain(AI_QUEUE_NAME);
    expect(AI_QUEUE_NAME).toBe('ai-proposal-jobs');
  });

  it('retries transient failures 3 times with exponential backoff from 10s', () => {
    getAiProposalQueue();
    const opts = state.queues.find((q) => q.name === AI_QUEUE_NAME)!.opts.defaultJobOptions!;
    expect(opts['attempts']).toBe(3);
    expect(opts['backoff']).toEqual({ type: 'exponential', delay: 10_000 });
  });

  it('uses proposalId-run as the job id: same run dedupes, a retry run is a new job', async () => {
    await enqueueAiProposalJob('abc', 1);
    await enqueueAiProposalJob('abc', 1);
    expect([...state.jobs.keys()]).toEqual(['abc-1']);
    await enqueueAiProposalJob('abc', 2);
    expect([...state.jobs.keys()]).toEqual(['abc-1', 'abc-2']);
    expect(state.jobs.get('abc-2')!.data).toEqual({ proposalId: 'abc' });
  });

  it('is a singleton until closeQueue resets it', async () => {
    expect(getAiProposalQueue()).toBe(getAiProposalQueue());
    const before = getAiProposalQueue();
    await closeQueue();
    expect(getAiProposalQueue()).not.toBe(before);
  });
});

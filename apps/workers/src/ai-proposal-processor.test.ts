import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
// `mongoose` is not a dependency of apps/workers; use the instance the db package re-exports.
import {
  AI_PROPOSAL_RAW_OUTPUT_MAX,
  AiProposal,
  connectDB,
  disconnectDB,
  mongoose,
} from '@instantmockapi/db';
import { loadEnvConfig } from '@instantmockapi/config';

const { Types } = mongoose;
import {
  ProviderError,
  createScriptedProvider,
  fakeOutputJson,
  type LLMProvider,
} from '@instantmockapi/ai';
import { processAiProposalJob, settleExhaustedAiProposal } from './ai-proposal-processor.js';

let mongod: MongoMemoryServer;
const config = { ...loadEnvConfig(), geminiApiKey: '' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});
afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});
beforeEach(async () => {
  await AiProposal.deleteMany({});
});

async function generating(extra: Record<string, unknown> = {}) {
  return AiProposal.create({
    ownerId: new Types.ObjectId(),
    prompt: 'any domain at all',
    model: 'm',
    promptVersion: 'v',
    ...extra,
  });
}

async function run(id: unknown, provider: LLMProvider) {
  await processAiProposalJob({ proposalId: String(id), run: 1 }, { config, provider });
  return AiProposal.findById(id).lean();
}

describe('processAiProposalJob', () => {
  it('stores a valid proposal as ready', async () => {
    const doc = await generating();
    const after = await run(doc._id, createScriptedProvider(fakeOutputJson(['Alpha', 'Beta'])));
    expect(after).toMatchObject({
      status: 'ready',
      stage: null,
      geminiCalls: 1,
      error: null,
      rawOutput: null,
    });
    expect(after!.result!.entities.map((e: { name: string }) => e.name)).toEqual(['Alpha', 'Beta']);
    expect(after!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a repair', async () => {
    const doc = await generating();
    const after = await run(doc._id, createScriptedProvider('not json', fakeOutputJson(['Alpha'])));
    expect(after).toMatchObject({ status: 'ready', geminiCalls: 2 });
  });

  it('stores IPS details and raw output when the repair also fails', async () => {
    const doc = await generating();
    const bad = fakeOutputJson([], { entities: [] });
    const after = await run(doc._id, createScriptedProvider(bad, bad));
    expect(after).toMatchObject({ status: 'failed', stage: null, rawOutput: bad, result: null });
    expect(after!.error!.code).toBe('AI_GENERATION_FAILED');
    expect(after!.error!.details.length).toBeGreaterThan(0);
  });

  it('rethrows transient errors and leaves the proposal generating for the retry', async () => {
    const doc = await generating();
    await expect(
      processAiProposalJob(
        { proposalId: String(doc._id), run: 1 },
        { config, provider: createScriptedProvider(new ProviderError('transient', 'HTTP 503')) },
      ),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('generating');
  });

  it('discards a late result when the proposal was cancelled mid-generation', async () => {
    const doc = await generating();
    const provider: LLMProvider = {
      model: 'm',
      async generate() {
        await AiProposal.updateOne({ _id: doc._id }, { $set: { status: 'cancelled' } });
        return fakeOutputJson(['Alpha']);
      },
    };
    const after = await run(doc._id, provider);
    expect(after).toMatchObject({ status: 'cancelled', result: null });
  });

  it('stops after a cancel and does not pay for the repair call', async () => {
    const doc = await generating();
    const scripted = createScriptedProvider('not json at all', fakeOutputJson(['Alpha']));
    const provider: LLMProvider = {
      model: scripted.model,
      async generate(request) {
        const text = await scripted.generate(request);
        // Cancelled while call 1 is in flight; its answer is invalid, so a repair would follow.
        await AiProposal.updateOne({ _id: doc._id }, { $set: { status: 'cancelled' } });
        return text;
      },
    };
    const after = await run(doc._id, provider);
    expect(scripted.calls).toHaveLength(1);
    expect(after).toMatchObject({ status: 'cancelled', result: null });
  });

  it('does nothing for a proposal that is not generating', async () => {
    const doc = await generating({ status: 'ready' });
    const provider = createScriptedProvider();
    await run(doc._id, provider);
    expect(provider.calls).toHaveLength(0);
  });

  it('finishes quietly when the proposal no longer exists (Review Focus #4)', async () => {
    const provider = createScriptedProvider();
    await expect(
      processAiProposalJob(
        { proposalId: String(new Types.ObjectId()), run: 1 },
        { config, provider },
      ),
    ).resolves.toBeUndefined();
    await expect(
      processAiProposalJob({ proposalId: 'not-an-object-id', run: 1 }, { config, provider }),
    ).resolves.toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('fails with AI_NOT_CONFIGURED when there is no key and no provider', async () => {
    const doc = await generating();
    await processAiProposalJob({ proposalId: String(doc._id), run: 1 }, { config });
    const after = await AiProposal.findById(doc._id).lean();
    expect(after).toMatchObject({ status: 'failed' });
    expect(after!.error!.code).toBe('AI_NOT_CONFIGURED');
  });

  it('ignores a stale job whose run no longer matches the document', async () => {
    const doc = await generating({ runs: 2 });
    const provider = createScriptedProvider();
    await run(doc._id, provider);
    expect(provider.calls).toHaveLength(0);
    expect(await AiProposal.findById(doc._id).lean()).toMatchObject({
      status: 'generating',
      runs: 2,
      result: null,
    });
  });

  it('writes AI_NOT_CONFIGURED when the provider rejects the key (config error)', async () => {
    const doc = await generating();
    const after = await run(
      doc._id,
      createScriptedProvider(new ProviderError('config', 'HTTP 401')),
    );
    expect(after).toMatchObject({ status: 'failed' });
    expect(after!.error!.code).toBe('AI_NOT_CONFIGURED');
  });

  it('truncates stored raw output to AI_PROPOSAL_RAW_OUTPUT_MAX', async () => {
    const doc = await generating();
    const huge = 'x'.repeat(AI_PROPOSAL_RAW_OUTPUT_MAX + 5000);
    const after = await run(doc._id, createScriptedProvider(huge, huge));
    expect(after).toMatchObject({ status: 'failed' });
    expect(after!.rawOutput).toHaveLength(AI_PROPOSAL_RAW_OUTPUT_MAX);
  });
});

describe('settleExhaustedAiProposal', () => {
  it('marks a still-generating proposal failed with a retryable message', async () => {
    const doc = await generating();
    await settleExhaustedAiProposal({ proposalId: String(doc._id), run: 1 }, new Error('HTTP 503'));
    const after = await AiProposal.findById(doc._id).lean();
    expect(after).toMatchObject({ status: 'failed', stage: null });
    expect(after!.error!.code).toBe('AI_GENERATION_FAILED');
    expect(after!.error!.message).toMatch(/try again/i);
  });

  it('leaves a proposal that already settled untouched', async () => {
    const doc = await generating({ status: 'ready' });
    await settleExhaustedAiProposal({ proposalId: String(doc._id), run: 1 }, new Error('x'));
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('ready');
  });

  it('leaves a retried (newer run) generating proposal untouched', async () => {
    const doc = await generating({ runs: 2 });
    await settleExhaustedAiProposal({ proposalId: String(doc._id), run: 1 }, new Error('HTTP 503'));
    expect((await AiProposal.findById(doc._id).lean())!.status).toBe('generating');
  });
});

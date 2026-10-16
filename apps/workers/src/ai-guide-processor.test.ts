import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ProjectGuide, connectDB, disconnectDB, mongoose } from '@instantmockapi/db';
import { loadEnvConfig } from '@instantmockapi/config';
import { ProviderError, createScriptedProvider } from '@instantmockapi/ai';
import { processAiProposalJob, settleExhaustedAiProposal } from './ai-proposal-processor.js';

const { Types } = mongoose;
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
  await ProjectGuide.deleteMany({});
});

const guide = (extra: Record<string, unknown> = {}) =>
  ProjectGuide.create({
    projectId: new Types.ObjectId(),
    contextHash: 'hash',
    context: 'Project: Tours\n- GET | /tours',
    endpoints: [{ method: 'GET', path: '/tours' }],
    version: 1,
    ...extra,
  });

const reply = (markdown: string) => JSON.stringify({ markdown });

async function run(id: unknown, provider = createScriptedProvider(reply('## Overview'))) {
  await processAiProposalJob(
    { proposalId: String(id), run: 1, kind: 'guide' },
    { config, provider },
  );
  return { provider, after: await ProjectGuide.findById(id).lean() };
}

describe('guide jobs', () => {
  it('stores the guide as ready, written from the stored context', async () => {
    const doc = await guide();
    const { provider, after } = await run(
      doc._id,
      createScriptedProvider(reply('## Overview\nList with `GET /tours`.')),
    );
    expect(after).toMatchObject({
      status: 'ready',
      markdown: '## Overview\nList with `GET /tours`.',
      error: null,
      geminiCalls: 1,
      promptVersion: 'guide-v1',
    });
    expect(provider.calls[0]!.turns[0]!.text).toContain('Project: Tours');
  });

  it('stores a failure when the model keeps inventing endpoints', async () => {
    const doc = await guide();
    const bad = reply('Use `POST /reviews`.');
    const { after } = await run(doc._id, createScriptedProvider(bad, bad));
    expect(after).toMatchObject({ status: 'failed', markdown: null });
    expect(after!.error!.message).toMatch(/could not write a guide/i);
  });

  it('ignores a job from an earlier run', async () => {
    const doc = await guide({ runs: 2 });
    const { provider, after } = await run(doc._id);
    expect(provider.calls).toHaveLength(0);
    expect(after!.status).toBe('generating');
  });

  it('rethrows a transient error for the queue to retry, then settles as failed', async () => {
    const doc = await guide();
    await expect(
      processAiProposalJob(
        { proposalId: String(doc._id), run: 1, kind: 'guide' },
        { config, provider: createScriptedProvider(new ProviderError('transient', 'HTTP 503')) },
      ),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect((await ProjectGuide.findById(doc._id))!.status).toBe('generating');

    await settleExhaustedAiProposal(
      { proposalId: String(doc._id), run: 1, kind: 'guide' },
      new Error('HTTP 503'),
    );
    const after = await ProjectGuide.findById(doc._id).lean();
    expect(after).toMatchObject({ status: 'failed' });
    expect(after!.error!.message).toMatch(/busy/i);
  });
});

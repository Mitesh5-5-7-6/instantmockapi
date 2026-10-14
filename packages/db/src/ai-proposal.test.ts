import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import { AI_PROPOSAL_TTL_SECONDS, AiProposal, connectDB, disconnectDB } from './index.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});

describe('AiProposal', () => {
  it('applies operational defaults', async () => {
    const doc = await AiProposal.create({
      ownerId: new Types.ObjectId(),
      prompt: 'p',
      model: 'm',
      promptVersion: 'v',
    });
    expect(doc.status).toBe('generating');
    expect(doc.stage).toBe('queued');
    expect(doc.result).toBeNull();
    expect(doc.error).toBeNull();
    expect(doc.geminiCalls).toBe(0);
    expect(doc.runs).toBe(1);
    expect(doc.projectId).toBeNull();
  });

  it('expires after 30 days and indexes owner history', async () => {
    await AiProposal.syncIndexes();
    const indexes = await AiProposal.collection.indexes();
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
    expect(ttl?.key).toEqual({ createdAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(AI_PROPOSAL_TTL_SECONDS);
    expect(AI_PROPOSAL_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(
      indexes.some(
        (index) => JSON.stringify(index.key) === JSON.stringify({ ownerId: 1, createdAt: -1 }),
      ),
    ).toBe(true);
  });
});

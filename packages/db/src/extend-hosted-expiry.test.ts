import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { connectDB, disconnectDB } from './connection.js';
import { Project, type IProject } from './models/project.js';
import { Version } from './models/version.js';
import { extendHostedExpiry } from './extend-hosted-expiry.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const days = (count: number) => new Date(NOW.getTime() + count * DAY);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
});

async function hosted(
  status: IProject['status'],
  expiresAt: Date | null,
  publishedAt?: Date,
): Promise<Types.ObjectId> {
  const project = await Project.create({
    ownerId: new Types.ObjectId(),
    name: 'Hosted',
    status,
    inputSource: { type: 'json', raw: '{}' },
    ips: { projectId: 'p', version: 1, entities: [], generationConfig: {} },
    generationConfig: {},
    currentVersion: 1,
    publishedVersion: 1,
    hosted: { url: expiresAt ? 'https://x/p/1' : null, expiresAt },
  });
  if (publishedAt) {
    await Version.create({
      projectId: project._id,
      version: 1,
      ipsSnapshot: {},
      configSnapshot: {},
      publishedAt,
    });
  }
  return project._id;
}

const expiryOf = async (id: Types.ObjectId) =>
  (await Project.findById(id))?.hosted.expiresAt?.toISOString() ?? null;

describe('extendHostedExpiry', () => {
  it('moves a live API to 30 days after its last publish', async () => {
    // Published yesterday under the old two-day lifetime.
    const id = await hosted('active', days(1), days(-1));
    const result = await extendHostedExpiry(NOW);
    expect(await expiryOf(id)).toBe(days(29).toISOString());
    expect(result).toEqual({ checked: 1, extended: 1 });
  });

  it('falls back to the old two-day lifetime when the publish time is unknown', async () => {
    const id = await hosted('active', days(1));
    await extendHostedExpiry(NOW);
    expect(await expiryOf(id)).toBe(days(29).toISOString());
  });

  it('never shortens an expiry that is already later', async () => {
    const id = await hosted('active', days(45), days(-1));
    const result = await extendHostedExpiry(NOW);
    expect(await expiryOf(id)).toBe(days(45).toISOString());
    expect(result.extended).toBe(0);
  });

  it('leaves expired and unpublished projects alone', async () => {
    // An expired project's mock data is already deleted; reviving its URL would
    // serve nothing, so it has to be published again instead.
    const expired = await hosted('expired', null, days(-5));
    const draft = await hosted('draft', null);
    await extendHostedExpiry(NOW);
    expect(await expiryOf(expired)).toBeNull();
    expect(await expiryOf(draft)).toBeNull();
  });

  it('changes nothing when run a second time', async () => {
    const id = await hosted('active', days(1), days(-1));
    await extendHostedExpiry(NOW);
    const second = await extendHostedExpiry(NOW);
    expect(second.extended).toBe(0);
    expect(await expiryOf(id)).toBe(days(29).toISOString());
  });
});

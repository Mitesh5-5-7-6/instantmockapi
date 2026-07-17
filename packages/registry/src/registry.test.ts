import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import { connectDB, disconnectDB, Artifact, type ArtifactStatus } from '@instantmockapi/db';
import {
  createOrResetArtifactRecord,
  transitionArtifactStatus,
  getArtifactsForVersion,
  getArtifactRecord,
} from './registry.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDB(mongod.getUri());
});

afterAll(async () => {
  await disconnectDB();
  await mongod.stop();
});

function newProjectId(): string {
  return new Types.ObjectId().toHexString();
}

/** Seed an artifact directly in a given state, bypassing the state machine. */
async function seedArtifact(status: ArtifactStatus, extras: Record<string, unknown> = {}) {
  const projectId = newProjectId();
  await Artifact.create({ projectId, artifactType: 'zod', version: 1, status, ...extras });
  return projectId;
}

describe('state machine — exhaustive transitions', () => {
  const STATUSES: ArtifactStatus[] = ['pending', 'generating', 'completed', 'failed'];
  const LEGAL: Record<ArtifactStatus, ArtifactStatus[]> = {
    pending: ['generating'],
    generating: ['completed', 'failed'],
    completed: ['generating'], // regeneration
    failed: ['generating'], // retry
  };

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = LEGAL[from].includes(to);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'rejected'}`, async () => {
        const projectId = await seedArtifact(from);
        const res = await transitionArtifactStatus(projectId, 'zod', 1, to);

        expect(res.ok).toBe(legal);
        const stored = await Artifact.findOne({
          projectId: new Types.ObjectId(projectId),
          artifactType: 'zod',
          version: 1,
        });
        if (legal) {
          expect(stored?.status).toBe(to);
        } else {
          if (!res.ok) {
            expect(res.error.code).toBe('VALIDATION_ERROR');
            expect(res.error.statusCode).toBe(422);
          }
          // Illegal transitions must not mutate the record
          expect(stored?.status).toBe(from);
        }
      });
    }
  }
});

describe('transition side effects', () => {
  it('completed stamps storageRef and generatedAt, clearing errorMessage', async () => {
    const projectId = await seedArtifact('generating', { errorMessage: 'previous failure' });
    const res = await transitionArtifactStatus(projectId, 'zod', 1, 'completed', {
      storageRef: 's3://bucket/zod.ts',
      workerId: 'B',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.storageRef).toBe('s3://bucket/zod.ts');
      expect(res.value.generatedAt).toBeInstanceOf(Date);
      expect(res.value.errorMessage).toBeNull();
      expect(res.value.workerId).toBe('B');
    }
  });

  it('completed without a new storageRef keeps the existing one', async () => {
    const projectId = await seedArtifact('generating', { storageRef: 's3://bucket/old.ts' });
    const res = await transitionArtifactStatus(projectId, 'zod', 1, 'completed');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.storageRef).toBe('s3://bucket/old.ts');
    }
  });

  it('failed stamps an error message (defaulted) and nulls storageRef', async () => {
    const projectId = await seedArtifact('generating', { storageRef: 's3://bucket/zod.ts' });
    const res = await transitionArtifactStatus(projectId, 'zod', 1, 'failed');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.errorMessage).toBe('Generation failed without details');
      expect(res.value.storageRef).toBeNull();
      expect(res.value.generatedAt).toBeInstanceOf(Date);
    }
  });

  it('failed records the provided error message', async () => {
    const projectId = await seedArtifact('generating');
    const res = await transitionArtifactStatus(projectId, 'zod', 1, 'failed', {
      errorMessage: 'boom',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.errorMessage).toBe('boom');
    }
  });

  it('re-entering generating clears the previous outcome fields', async () => {
    const projectId = await seedArtifact('completed', {
      storageRef: 's3://bucket/zod.ts',
      generatedAt: new Date(),
    });
    const res = await transitionArtifactStatus(projectId, 'zod', 1, 'generating', {
      workerId: 'B',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.storageRef).toBeNull();
      expect(res.value.errorMessage).toBeNull();
      expect(res.value.generatedAt).toBeNull();
      expect(res.value.workerId).toBe('B');
    }
  });

  it('returns NOT_FOUND when the registry record does not exist', async () => {
    const res = await transitionArtifactStatus(newProjectId(), 'zod', 1, 'generating');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns INTERNAL_ERROR for a malformed projectId', async () => {
    const res = await transitionArtifactStatus('not-an-object-id', 'zod', 1, 'generating');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INTERNAL_ERROR');
    }
  });
});

describe('createOrResetArtifactRecord', () => {
  it('creates a fresh pending record', async () => {
    const projectId = newProjectId();
    const res = await createOrResetArtifactRecord(projectId, 'typescript', 3);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('pending');
      expect(res.value.version).toBe(3);
      expect(res.value.workerId).toBeNull();
      expect(res.value.storageRef).toBeNull();
    }
  });

  it('resets an existing completed record back to pristine pending', async () => {
    const projectId = await seedArtifact('completed', {
      storageRef: 's3://bucket/zod.ts',
      workerId: 'B',
      generatedAt: new Date(),
      errorMessage: null,
    });
    const res = await createOrResetArtifactRecord(projectId, 'zod', 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('pending');
      expect(res.value.storageRef).toBeNull();
      expect(res.value.workerId).toBeNull();
      expect(res.value.generatedAt).toBeNull();
      expect(res.value.errorMessage).toBeNull();
    }
    // No duplicate row was created (upsert on the compound key)
    expect(
      await Artifact.countDocuments({
        projectId: new Types.ObjectId(projectId),
        artifactType: 'zod',
        version: 1,
      }),
    ).toBe(1);
  });
});

describe('queries', () => {
  it('getArtifactsForVersion returns only the requested version', async () => {
    const projectId = newProjectId();
    await createOrResetArtifactRecord(projectId, 'zod', 1);
    await createOrResetArtifactRecord(projectId, 'yup', 1);
    await createOrResetArtifactRecord(projectId, 'zod', 2);

    const res = await getArtifactsForVersion(projectId, 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(2);
      expect(res.value.every((a) => a.version === 1)).toBe(true);
    }
  });

  it('getArtifactRecord returns the record, or ok(null) when missing', async () => {
    const projectId = newProjectId();
    await createOrResetArtifactRecord(projectId, 'zod', 1);

    const hit = await getArtifactRecord(projectId, 'zod', 1);
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value?.artifactType).toBe('zod');
    }

    const miss = await getArtifactRecord(projectId, 'openapi', 1);
    expect(miss.ok).toBe(true);
    if (miss.ok) {
      expect(miss.value).toBeNull();
    }
  });
});

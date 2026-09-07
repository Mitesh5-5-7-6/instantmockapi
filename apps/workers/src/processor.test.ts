import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import JSZip from 'jszip';
import {
  Artifact,
  Job,
  MockStore,
  Project,
  User,
  Version,
  connectDB,
  disconnectDB,
  type IJob,
  type IProject,
} from '@instantmockapi/db';
import { createOrResetArtifactRecord } from '@instantmockapi/registry';
import type { GenerationJobPayload } from '@instantmockapi/queue';
import { createMemoryStorage, decodeBundle } from '@instantmockapi/storage';
import type { InternalProjectSchema } from '@instantmockapi/ips';
import type { ArtifactType } from '@instantmockapi/shared';
import { processGenerationJob, type ProcessorDeps } from './processor';
import { DEFAULT_PRODUCERS, workerForArtifact, type ArtifactProducer } from './artifacts.js';

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
    [User, Project, Version, Artifact, Job, MockStore].map((model) => model.deleteMany({})),
  );
});

const FULL_ARTIFACTS: ArtifactType[] = [
  'json_schema',
  'zod',
  'yup',
  'typescript',
  'mock_data',
  'openapi',
  'postman',
  'hosted_api',
  'export_zip',
];

function makeIps(projectId: string): InternalProjectSchema {
  return {
    projectId,
    version: 1,
    entities: [
      {
        name: 'Customer',
        fields: [
          {
            name: 'id',
            type: 'uuid',
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: { unique: true },
          },
          {
            name: 'name',
            type: 'string',
            required: true,
            default: '',
            children: [],
            validation: { min: 2, max: 50 },
            meta: {},
          },
          {
            name: 'email',
            type: 'email',
            required: true,
            default: null,
            children: [],
            validation: { email: true },
            meta: {},
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod', 'yup'],
      types: ['typescript'],
      methods: ['GET', 'POST'],
      mockRecords: 3,
    },
  };
}

/** Stage the DB exactly as the API's createGenerationJob does (doc 10 §1). */
async function stageJob(requestedArtifacts: ArtifactType[]): Promise<{
  payload: GenerationJobPayload;
  project: IProject;
  job: IJob;
}> {
  const user = await User.create({
    email: `owner-${Date.now()}-${Math.random()}@x.dev`,
    authProvider: 'email',
  });
  const project = new Project({
    ownerId: user._id,
    name: 'Pipeline Test',
    status: 'generating',
    inputSource: { type: 'json', raw: '{}' },
    currentVersion: 1,
  });
  const ips = makeIps(String(project._id));
  project.ips = ips;
  project.generationConfig = ips.generationConfig;
  await project.save();

  await Version.create({
    projectId: project._id,
    version: 1,
    ipsSnapshot: ips,
    configSnapshot: ips.generationConfig,
  });

  for (const artifactType of requestedArtifacts) {
    const reset = await createOrResetArtifactRecord(String(project._id), artifactType, 1);
    if (!reset.ok) {
      throw reset.error;
    }
  }

  const job = await Job.create({
    projectId: project._id,
    version: 1,
    type: 'full',
    requestedArtifacts,
    idempotencyKey: `key-${String(project._id)}`,
    status: 'queued',
    workers: requestedArtifacts.map((artifactType) => ({
      worker: workerForArtifact(artifactType) ?? '?',
      artifactType,
      status: 'queued',
      error: null,
    })),
  });

  return {
    payload: {
      projectId: String(project._id),
      version: 1,
      type: 'full',
      requestedArtifacts,
      jobId: String(job._id),
    },
    project,
    job,
  };
}

function deps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    storage: createMemoryStorage(),
    retry: { attempts: 1, delayMs: 0 },
    ...overrides,
  };
}

describe('full pipeline', () => {
  it('completes every artifact, seeds mock stores, activates hosting, settles the job', async () => {
    const { payload, project } = await stageJob(FULL_ARTIFACTS);
    const d = deps();
    await processGenerationJob(payload, d);

    // Registry: everything completed with a storageRef
    const artifacts = await Artifact.find({ projectId: project._id, version: 1 });
    expect(artifacts).toHaveLength(FULL_ARTIFACTS.length);
    for (const artifact of artifacts) {
      expect(artifact.status).toBe('completed');
      expect(artifact.storageRef).toBeTruthy();
    }

    // Job settled: completed, all workers completed, completedAt stamped
    const job = await Job.findById(payload.jobId);
    expect(job?.status).toBe('completed');
    expect(job?.completedAt).toBeInstanceOf(Date);
    expect(job?.workers.every((w) => w.status === 'completed')).toBe(true);

    // Project activated with hosted URL + plan-based expiry (free = 2 days).
    // Addressing is minted on settle, so the URL is the advertised pretty form
    // `{publicId}/{slug}` — the legacy `/p/{projectId}` form still resolves but is
    // no longer what gets stamped (doc 19 §Phase 3).
    const updated = await Project.findById(project._id);
    expect(updated?.status).toBe('active');
    expect(updated?.publicId).toMatch(/^prj_[0-9a-f]{10}$/);
    expect(updated?.slug).toBeTruthy();
    expect(updated?.hosted.url).toBe(
      `https://api.instantmockapi.dev/p/${updated?.publicId}/${updated?.slug}`,
    );
    expect(updated?.hosted.expiresAt).toBeInstanceOf(Date);

    // Mock stores seeded from Worker D's records
    const store = await MockStore.findOne({ projectId: project._id, entity: 'customer' });
    expect(store?.records).toHaveLength(3);

    // Docs consumed Worker D's data: the OpenAPI example IS a seeded record
    const openapiArtifact = artifacts.find((a) => a.artifactType === 'openapi');
    const openapiObject = await d.storage.get(openapiArtifact?.storageRef ?? '');
    const spec = JSON.parse(new TextDecoder().decode(openapiObject?.body));
    const example = spec.paths['/customer'].post.requestBody.content['application/json'].example;
    expect(store?.records[0]).toEqual(example);

    // Export bundle contains every other artifact's files plus the README
    const exportArtifact = artifacts.find((a) => a.artifactType === 'export_zip');
    const zipObject = await d.storage.get(exportArtifact?.storageRef ?? '');
    const zip = await JSZip.loadAsync(zipObject?.body ?? new Uint8Array());
    const paths = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);
    expect(paths).toContain('README.md');
    expect(paths).toContain('zod/customer.zod.ts');
    expect(paths).toContain('typescript/customer.types.ts');
    expect(paths).toContain('openapi/openapi.json');
    const readme = await zip.file('README.md')?.async('string');
    expect(readme).toContain('IPS version: 1');

    // The first-publish exception, asserted rather than assumed. Generation does
    // not publish (Phase 2 §1) — except for a project with nothing live, because
    // onboarding has to end on a working URL and there is no live runtime to
    // disturb. Everything above (status, hosted URL, expiry) is a consequence of
    // that exception firing, so without this line the test would pass just as
    // happily if publishing had become unconditional again.
    expect(updated?.publishedVersion).toBe(1);
  });
});

describe('generation does not publish (Phase 2 §1)', () => {
  /**
   * The whole point of explicit publish, and the case the fresh-project tests
   * above cannot cover: a project that is *already serving* something.
   */
  it('leaves a live project on its published version after a clean generation', async () => {
    const { payload, project } = await stageJob(FULL_ARTIFACTS);

    // The state a successful publish leaves behind. `hosted.url` is what makes
    // this project "live"; see `hasLiveDeployment`.
    const live = await Project.findById(project._id);
    live!.publishedVersion = 1;
    live!.status = 'active';
    live!.hosted = {
      url: 'https://api.instantmockapi.dev/p/prj_deadbeef00/shop',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    };
    await live!.save();

    // Generate into a NEW version, as every route does for a live project.
    await Version.create({
      projectId: project._id,
      version: 2,
      ipsSnapshot: live!.ips,
      configSnapshot: live!.generationConfig,
    });
    for (const artifactType of FULL_ARTIFACTS) {
      const reset = await createOrResetArtifactRecord(String(project._id), artifactType, 2);
      if (!reset.ok) {
        throw reset.error;
      }
    }

    await processGenerationJob({ ...payload, version: 2 }, deps());

    const updated = await Project.findById(project._id);
    // v2 generated cleanly and is READY — and is not live.
    expect(
      await Artifact.countDocuments({ projectId: project._id, version: 2, status: 'completed' }),
    ).toBe(FULL_ARTIFACTS.length);
    expect(updated?.publishedVersion).toBe(1);
    // The live deployment is untouched, down to the expiry: publishing is what
    // restarts that clock, and generation must not.
    expect(updated?.hosted.url).toBe('https://api.instantmockapi.dev/p/prj_deadbeef00/shop');
    expect(updated?.hosted.expiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(updated?.status).toBe('active');
  });

  /**
   * The regression guard for the trap in this design.
   *
   * `pinPublishedVersion` stamps `publishedVersion` speculatively on the first
   * edit, so a project whose very first action was a partial regenerate has
   * `publishedVersion = 1` pointing at a version with **no artifacts** — nothing
   * has ever been live. Keying the exception on `publishedVersion != null` would
   * withhold the first publish from exactly that user, leaving them with a READY
   * version, no hosted URL, and no way to know why.
   */
  it('still publishes the first version when the pointer was only pinned, never served', async () => {
    const { payload, project } = await stageJob(FULL_ARTIFACTS);

    const pinned = await Project.findById(project._id);
    pinned!.publishedVersion = 1;
    // The tell: no hosted URL. `publishedVersion` is set, but nothing is live.
    pinned!.hosted = { url: null, expiresAt: null };
    await pinned!.save();

    await processGenerationJob(payload, deps());

    const updated = await Project.findById(project._id);
    expect(updated?.publishedVersion).toBe(1);
    expect(updated?.hosted.url).toBeTruthy();
    expect(updated?.status).toBe('active');
  });

  it('leaves a project with nothing live as a draft when generation produces no runtime', async () => {
    // A zod-only job on a fresh project used to end with `status: 'active'` and
    // no hosted API at all — `status` is the runtime's live-or-not gate, so that
    // was a claim nothing backed.
    const { payload, project } = await stageJob(['zod']);
    await processGenerationJob(payload, deps());

    const updated = await Project.findById(project._id);
    expect(updated?.status).toBe('draft');
    expect(updated?.hosted.url).toBeFalsy();
    expect(updated?.publishedVersion ?? null).toBeNull();
  });
});

describe('selective generation (doc 09 §5)', () => {
  it('a zod-only job touches nothing else', async () => {
    const { payload, project } = await stageJob(['zod']);
    const d = deps();
    await processGenerationJob(payload, d);

    const zodRow = await Artifact.findOne({ projectId: project._id, artifactType: 'zod' });
    expect(zodRow?.status).toBe('completed');
    expect(await Artifact.countDocuments({ projectId: project._id })).toBe(1);

    const bundle = await d.storage.get(zodRow?.storageRef ?? '');
    expect(Object.keys(decodeBundle(bundle?.body ?? '').files)).toEqual(['customer.zod.ts']);

    const job = await Job.findById(payload.jobId);
    expect(job?.status).toBe('completed');
  });

  it('a partial docs-only job regenerates D in-memory to supply examples', async () => {
    const { payload, project } = await stageJob(['openapi']);
    await processGenerationJob(payload, deps());

    const row = await Artifact.findOne({ projectId: project._id, artifactType: 'openapi' });
    expect(row?.status).toBe('completed');
    // mock_data was never staged as an artifact
    expect(
      await Artifact.countDocuments({ projectId: project._id, artifactType: 'mock_data' }),
    ).toBe(0);
  });
});

describe('DAG ordering (doc 10 §4)', () => {
  it('E starts only after D finishes; G starts after everything else', async () => {
    const { payload } = await stageJob(['mock_data', 'zod', 'openapi', 'export_zip']);
    const events: string[] = [];
    const instrument =
      (type: ArtifactType, delayMs = 0): ArtifactProducer =>
      async (ctx) => {
        events.push(`start:${type}`);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const result = await DEFAULT_PRODUCERS[type](ctx);
        events.push(`end:${type}`);
        return result;
      };

    await processGenerationJob(
      payload,
      deps({
        producers: {
          mock_data: instrument('mock_data', 100),
          zod: instrument('zod'),
          openapi: instrument('openapi'),
          export_zip: instrument('export_zip'),
        },
      }),
    );

    expect(events.indexOf('end:mock_data')).toBeLessThan(events.indexOf('start:openapi'));
    expect(events.indexOf('end:openapi')).toBeLessThan(events.indexOf('start:export_zip'));
    expect(events.indexOf('end:zod')).toBeLessThan(events.indexOf('start:export_zip'));
  });
});

describe('retry strategy (doc 10 §6)', () => {
  it('auto-retries a transient failure and succeeds', async () => {
    const { payload, project } = await stageJob(['zod']);
    let attempts = 0;
    await processGenerationJob(
      payload,
      deps({
        retry: { attempts: 3, delayMs: 1 },
        producers: {
          zod: (ctx) => {
            attempts += 1;
            if (attempts < 3) {
              throw new Error('transient');
            }
            return DEFAULT_PRODUCERS.zod(ctx);
          },
        },
      }),
    );

    expect(attempts).toBe(3);
    const row = await Artifact.findOne({ projectId: project._id, artifactType: 'zod' });
    expect(row?.status).toBe('completed');
  });

  it('marks the artifact failed with errorMessage after exhaustion — siblings unaffected', async () => {
    const { payload, project } = await stageJob(['zod', 'typescript', 'export_zip']);
    const d = deps({
      retry: { attempts: 2, delayMs: 1 },
      producers: {
        zod: () => {
          throw new Error('boom');
        },
      },
    });
    await processGenerationJob(payload, d);

    const zodRow = await Artifact.findOne({ projectId: project._id, artifactType: 'zod' });
    expect(zodRow?.status).toBe('failed');
    expect(zodRow?.errorMessage).toBe('boom');

    // Sibling completed (failure isolation, doc 10 §7)
    const tsRow = await Artifact.findOne({ projectId: project._id, artifactType: 'typescript' });
    expect(tsRow?.status).toBe('completed');

    // Job settles failed_partial, never a global failure
    const job = await Job.findById(payload.jobId);
    expect(job?.status).toBe('failed_partial');
    const zodWorker = job?.workers.find((w) => w.artifactType === 'zod');
    expect(zodWorker?.status).toBe('failed');
    expect(zodWorker?.error).toBe('boom');

    // G bundled what exists: typescript in, zod out
    const exportRow = await Artifact.findOne({
      projectId: project._id,
      artifactType: 'export_zip',
    });
    expect(exportRow?.status).toBe('completed');
    const zipObject = await d.storage.get(exportRow?.storageRef ?? '');
    const zip = await JSZip.loadAsync(zipObject?.body ?? new Uint8Array());
    const readme = await zip.file('README.md')?.async('string');
    expect(readme).toContain('- typescript');
    expect(readme).not.toContain('- zod');
  });
});

describe('dependency gating', () => {
  it('skips E/F when D fails in the same job; mock stores stay unseeded', async () => {
    const { payload, project } = await stageJob(['mock_data', 'openapi', 'hosted_api']);
    await processGenerationJob(
      payload,
      deps({
        producers: {
          mock_data: () => {
            throw new Error('faker exploded');
          },
        },
      }),
    );

    const job = await Job.findById(payload.jobId);
    expect(job?.status).toBe('failed_partial');
    for (const artifactType of ['openapi', 'hosted_api'] as const) {
      const worker = job?.workers.find((w) => w.artifactType === artifactType);
      expect(worker?.status).toBe('failed');
      expect(worker?.error).toContain('mock_data');
      // Registry rows never entered 'generating' — still pending
      const row = await Artifact.findOne({ projectId: project._id, artifactType });
      expect(row?.status).toBe('pending');
    }

    expect(await MockStore.countDocuments({ projectId: project._id })).toBe(0);

    // Project falls back to draft: nothing completed
    const updated = await Project.findById(project._id);
    expect(updated?.status).toBe('draft');
    expect(updated?.hosted.url).toBeNull();
  });
});

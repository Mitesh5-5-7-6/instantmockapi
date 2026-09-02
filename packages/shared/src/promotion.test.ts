import { describe, it, expect } from 'vitest';
import {
  RUNTIME_REQUIRED_ARTIFACTS,
  evaluatePromotion,
  evaluateRuntimeReadiness,
  isRuntimeRequiredArtifact,
  type ArtifactOutcome,
} from './promotion.js';
import type { ArtifactType } from './constants.js';

function outcome(
  artifactType: ArtifactType,
  status: ArtifactOutcome['status'] = 'completed',
): ArtifactOutcome {
  return { artifactType, status };
}

/** A version where everything generated cleanly. */
const ALL_GOOD: ArtifactOutcome[] = [
  outcome('hosted_api'),
  outcome('mock_data'),
  outcome('openapi'),
  outcome('postman'),
  outcome('zod'),
  outcome('typescript'),
  outcome('json_schema'),
];

describe('the runtime-required set', () => {
  it('contains hosted_api', () => {
    // The config the mock runtime actually reads. Without a completed one, a
    // version cannot answer a request at all.
    expect(isRuntimeRequiredArtifact('hosted_api')).toBe(true);
  });

  /**
   * The rule this whole module exists to encode: developer-facing outputs are not
   * production infrastructure. A broken documentation generator must not keep a
   * working API off the air.
   */
  it('does not contain any developer-facing output', () => {
    for (const type of [
      'openapi',
      'postman',
      'zod',
      'yup',
      'typescript',
      'json_schema',
      'export_zip',
    ] as ArtifactType[]) {
      expect(isRuntimeRequiredArtifact(type)).toBe(false);
    }
  });

  /**
   * A real decision, not an omission. If seeding fails the endpoints still
   * answer — they answer with whatever records are already there.
   */
  it('does not contain mock_data', () => {
    expect(isRuntimeRequiredArtifact('mock_data')).toBe(false);
  });

  it('is small on purpose', () => {
    // A large required set means more ways for a working API to be held back.
    expect(RUNTIME_REQUIRED_ARTIFACTS).toHaveLength(1);
  });
});

describe('evaluateRuntimeReadiness', () => {
  it('is ready when everything completed', () => {
    const readiness = evaluateRuntimeReadiness(ALL_GOOD);
    expect(readiness).toMatchObject({ ready: true, blocking: [], degraded: [] });
  });

  it('is ready when only optional artifacts failed', () => {
    // The headline case. OpenAPI and Postman are downloads; the API works.
    const readiness = evaluateRuntimeReadiness([
      outcome('hosted_api'),
      outcome('openapi', 'failed'),
      outcome('postman', 'failed'),
    ]);
    expect(readiness.ready).toBe(true);
    expect(readiness.degraded).toEqual(['openapi', 'postman']);
  });

  it('is not ready when hosted_api failed', () => {
    const readiness = evaluateRuntimeReadiness([
      outcome('hosted_api', 'failed'),
      outcome('openapi'),
    ]);
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toEqual(['hosted_api']);
  });

  /**
   * To the runtime there is no difference between "never generated" and
   * "generated and failed": both mean no config to serve. A version with no
   * artifact rows at all must not read as ready.
   */
  it('is not ready when hosted_api is absent entirely', () => {
    expect(evaluateRuntimeReadiness([outcome('openapi')]).ready).toBe(false);
    expect(evaluateRuntimeReadiness([]).ready).toBe(false);
    expect(evaluateRuntimeReadiness([]).blocking).toEqual(['hosted_api']);
  });

  it('is not ready while hosted_api is still pending or generating', () => {
    // Mid-job. The row exists but has no storageRef, which is exactly the state
    // the runtime treats as not-found.
    for (const status of ['pending', 'generating'] as const) {
      expect(evaluateRuntimeReadiness([outcome('hosted_api', status)]).ready).toBe(false);
    }
  });

  it('does not report a failed required artifact as merely degraded', () => {
    // Otherwise a blocking failure would render in the UI as a warning beside a
    // live API that is not actually live.
    const readiness = evaluateRuntimeReadiness([outcome('hosted_api', 'failed')]);
    expect(readiness.degraded).not.toContain('hosted_api');
    expect(readiness.blocking).toContain('hosted_api');
  });

  it('ignores optional artifacts that are merely pending', () => {
    // Still in flight is not the same as failed; only a failure is worth
    // reporting as degradation.
    const readiness = evaluateRuntimeReadiness([
      outcome('hosted_api'),
      outcome('openapi', 'pending'),
    ]);
    expect(readiness.degraded).toEqual([]);
  });

  describe('the stale-data risk', () => {
    /**
     * `MockStore` is keyed on `(projectId, entity)` with **no version**. So
     * promoting a schema whose seeding failed leaves the API serving records
     * shaped for the *previous* schema — the endpoints work, but response bodies
     * may be missing fields the new schema declares. Degraded, not down, and not
     * silent either.
     */
    it('is flagged when the runtime is ready but seeding failed', () => {
      const readiness = evaluateRuntimeReadiness([
        outcome('hosted_api'),
        outcome('mock_data', 'failed'),
      ]);
      expect(readiness.ready).toBe(true);
      expect(readiness.staleDataRisk).toBe(true);
    });

    it('is not flagged when seeding succeeded', () => {
      expect(evaluateRuntimeReadiness(ALL_GOOD).staleDataRisk).toBe(false);
    });

    it('is not flagged for a version that cannot serve anyway', () => {
      // No point warning about data on a version nobody will ever be served.
      const readiness = evaluateRuntimeReadiness([
        outcome('hosted_api', 'failed'),
        outcome('mock_data', 'failed'),
      ]);
      expect(readiness.staleDataRisk).toBe(false);
    });
  });
});

describe('evaluatePromotion', () => {
  it('promotes a runtime-ready version over an older live one', () => {
    const decision = evaluatePromotion({ candidate: 3, published: 2, outcomes: ALL_GOOD });
    expect(decision.promote).toBe(true);
    expect(decision.reason).toMatch(/promoting v3/i);
  });

  it('promotes the first version of a project that has published nothing', () => {
    const decision = evaluatePromotion({ candidate: 1, published: null, outcomes: ALL_GOOD });
    expect(decision.promote).toBe(true);
  });

  it('treats undefined published the same as null', () => {
    // Every project written before the version split has no publishedVersion.
    expect(
      evaluatePromotion({ candidate: 1, published: undefined, outcomes: ALL_GOOD }).promote,
    ).toBe(true);
  });

  /**
   * The invariant that outranks everything else here:
   *
   * > A failed generation can never destroy or temporarily disable the currently
   * > live version.
   */
  it('keeps the old version live when hosted_api failed', () => {
    const decision = evaluatePromotion({
      candidate: 3,
      published: 2,
      outcomes: [outcome('hosted_api', 'failed'), outcome('openapi')],
    });
    expect(decision.promote).toBe(false);
    // Names what to retry, so the log line is actionable.
    expect(decision.reason).toMatch(/hosted_api/);
    expect(decision.reason).toMatch(/keeping the current version live/i);
  });

  it('promotes anyway when only documentation failed, and says so', () => {
    const decision = evaluatePromotion({
      candidate: 3,
      published: 2,
      outcomes: [outcome('hosted_api'), outcome('openapi', 'failed')],
    });
    expect(decision.promote).toBe(true);
    // So the UI can render "API is live · OpenAPI generation failed, retry
    // available" rather than a flat "Generation failed" beside a working API.
    expect(decision.reason).toMatch(/optional artifacts failed: openapi/);
  });

  it('mentions the stale-data risk in its reason', () => {
    const decision = evaluatePromotion({
      candidate: 3,
      published: 2,
      outcomes: [outcome('hosted_api'), outcome('mock_data', 'failed')],
    });
    expect(decision.promote).toBe(true);
    expect(decision.reason).toMatch(/records may predate this schema/);
  });

  /**
   * Jobs settle out of order — a slow partial regenerate of v2 can finish after
   * v3 went live. Moving the pointer backwards would serve older artifacts than
   * the definition, and users would watch their API regress.
   */
  it('refuses to move the pointer backwards', () => {
    const decision = evaluatePromotion({ candidate: 2, published: 3, outcomes: ALL_GOOD });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/not newer than the live v3/);
  });

  it('refuses to re-promote the version already live', () => {
    // A no-op write is harmless but the decision should still read as "no".
    expect(evaluatePromotion({ candidate: 3, published: 3, outcomes: ALL_GOOD }).promote).toBe(
      false,
    );
  });

  it('carries the readiness detail for the caller to log or render', () => {
    const decision = evaluatePromotion({
      candidate: 3,
      published: 2,
      outcomes: [outcome('hosted_api'), outcome('zod', 'failed')],
    });
    expect(decision.readiness).toMatchObject({ ready: true, degraded: ['zod'] });
  });

  /** Every row from the user-supplied failure matrix, asserted directly. */
  describe('the failure matrix', () => {
    const cases: [string, ArtifactOutcome[], boolean][] = [
      [
        'hosted_api succeeds, OpenAPI fails',
        [outcome('hosted_api'), outcome('openapi', 'failed')],
        true,
      ],
      ['hosted_api fails', [outcome('hosted_api', 'failed')], false],
      [
        'mock data fails, runtime can operate',
        [outcome('hosted_api'), outcome('mock_data', 'failed')],
        true,
      ],
      ['Zod fails', [outcome('hosted_api'), outcome('zod', 'failed')], true],
      ['Postman fails', [outcome('hosted_api'), outcome('postman', 'failed')], true],
      ['runtime configuration fails', [outcome('hosted_api', 'failed'), outcome('zod')], false],
      ['all required runtime artifacts succeed', ALL_GOOD, true],
    ];

    it.each(cases)('%s → promote=%s', (_label, outcomes, expected) => {
      expect(evaluatePromotion({ candidate: 2, published: 1, outcomes }).promote).toBe(expected);
    });
  });
});

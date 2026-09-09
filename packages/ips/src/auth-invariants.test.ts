import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { entityAuth, projectAuth, NO_AUTH } from './auth.js';
import { diffSchemas } from './changes.js';
import { analyseDraftImpact } from './impact.js';
import type { AuthConfig, AuthMode, Entity, EntityAuth, InternalProjectSchema } from './types.js';

/**
 * The two invariants that hold Phase 3's authentication model together.
 *
 *   1. Effective protection is **resolved** from the mode and the entity
 *      together, before anything traverses the dependency graph.
 *   2. Nothing determining effective protection reads `entity.authentication`
 *      raw.
 *
 * ## Why these need a test rather than a convention
 *
 * The wrong version compiles, reads naturally, and is wrong only in the
 * direction that exposes data:
 *
 *     if (entity.authentication === 'PROTECTED') { requireToken(); }
 *
 * That is correct in `COMBINATION` mode and silently wrong in `ALL_PROTECTED` —
 * where the field is absent by design, so every entity reads as public. There is
 * no type error, no failing unit test of the surrounding function, and no
 * symptom until somebody reads a protected endpoint without a token.
 *
 * `entityAuth` exists so that the mode always wins. These tests are what keeps
 * it the only reader.
 */

/* ────────────────── invariant 1: resolution is a matrix ────────────────── */

const entity = (authentication?: EntityAuth): Entity => ({
  id: 'ent_x',
  name: 'Payment',
  fields: [{ id: 'ent_x_f1', name: 'id', type: 'uuid', required: true }],
  ...(authentication === undefined ? {} : { authentication }),
});

const config = (mode: AuthMode): AuthConfig => ({
  ...NO_AUTH,
  mode,
  signup: mode !== 'NONE',
  signin: mode !== 'NONE',
  refreshToken: mode !== 'NONE',
});

/** Every stamp state an entity can be in, including the one that matters most. */
const STAMPS: readonly (EntityAuth | undefined)[] = ['PUBLIC', 'PROTECTED', undefined];

/**
 * The specification, as a table.
 *
 * Twelve rows because there are twelve cases, written out rather than computed
 * so that changing the intended behaviour means editing an expectation a
 * reviewer can read — not re-deriving it from the implementation being tested.
 */
const EXPECTED: Record<AuthMode, Record<'PUBLIC' | 'PROTECTED' | 'absent', EntityAuth>> = {
  // No Auth API exists, so nothing can be protected.
  NONE: { PUBLIC: 'PUBLIC', PROTECTED: 'PUBLIC', absent: 'PUBLIC' },
  // The mode wins outright: a stale PROTECTED stamp does not protect.
  ALL_PUBLIC: { PUBLIC: 'PUBLIC', PROTECTED: 'PUBLIC', absent: 'PUBLIC' },
  // The mode wins outright: a stale PUBLIC stamp does not expose. This is the
  // row the naive `entity.authentication === 'PROTECTED'` check gets wrong.
  ALL_PROTECTED: { PUBLIC: 'PROTECTED', PROTECTED: 'PROTECTED', absent: 'PROTECTED' },
  // The only mode that consults the entity — and it fails closed when unstamped.
  COMBINATION: { PUBLIC: 'PUBLIC', PROTECTED: 'PROTECTED', absent: 'PROTECTED' },
};

const key = (stamp: EntityAuth | undefined) => stamp ?? ('absent' as const);

describe('invariant 1: the mode and the entity resolve together', () => {
  for (const mode of ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED', 'COMBINATION'] as const) {
    for (const stamp of STAMPS) {
      it(`${mode} with a ${key(stamp)} stamp resolves to ${EXPECTED[mode][key(stamp)]}`, () => {
        expect(entityAuth(config(mode), entity(stamp))).toBe(EXPECTED[mode][key(stamp)]);
      });
    }
  }

  it('never resolves to anything but PUBLIC or PROTECTED', () => {
    // There is no third state and no `undefined`. Every consumer can switch on
    // two values without a fallback branch that would have to guess.
    for (const mode of ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED', 'COMBINATION'] as const) {
      for (const stamp of STAMPS) {
        expect(['PUBLIC', 'PROTECTED']).toContain(entityAuth(config(mode), entity(stamp)));
      }
    }
  });

  it('resolves a project with no authentication block at all', () => {
    // §26. `projectAuth` absorbs the `undefined` so no caller has to.
    expect(entityAuth(projectAuth(undefined), entity('PROTECTED'))).toBe('PUBLIC');
  });
});

/* ───────── invariant 1b: the diff agrees with the resolver, not the field ───────── */

function ips(mode: AuthMode, stamp: EntityAuth | undefined): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities: [entity(stamp)],
    generationConfig: {
      validators: [],
      types: [],
      methods: ['GET', 'POST', 'DELETE'],
      mockRecords: 5,
    },
    ...(mode === 'NONE' ? {} : { authentication: config(mode) }),
  };
}

describe('invariant 1b: everything downstream reads the resolved value', () => {
  /**
   * The property, checked across every pair of states rather than at the two
   * points a hand-written test would pick: the diff reports an entity's
   * protection as changed **exactly when `entityAuth` says it changed**.
   *
   * If any part of the diff ever consults `entity.authentication` directly, some
   * pair here disagrees — a stale stamp flipping under a whole-project mode
   * would produce a phantom change, and a real mode change would produce none.
   */
  it('reports an entity auth change iff the resolved protection moved', () => {
    const modes = ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED', 'COMBINATION'] as const;

    for (const beforeMode of modes) {
      for (const beforeStamp of STAMPS) {
        for (const afterMode of modes) {
          for (const afterStamp of STAMPS) {
            const active = ips(beforeMode, beforeStamp);
            const draft = ips(afterMode, afterStamp);

            const resolvedMoved =
              entityAuth(projectAuth(active), entity(beforeStamp)) !==
              entityAuth(projectAuth(draft), entity(afterStamp));

            const changes = diffSchemas(active, draft);
            const reported = changes.some(
              (change) =>
                change.kind === 'ENTITY_AUTH_CHANGED' || change.kind === 'AUTH_MODE_CHANGED',
            );

            const label = `${beforeMode}/${key(beforeStamp)} → ${afterMode}/${key(afterStamp)}`;
            if (resolvedMoved) {
              // A real change in what callers must send must always be reported.
              expect(reported, `${label} moved but was not reported`).toBe(true);
            }
          }
        }
      }
    }
  });

  /**
   * The specific case the raw read gets wrong, asserted end to end so it fails
   * at the impact layer too rather than only in the resolver's own unit test.
   */
  it('protects an ALL_PROTECTED entity whose stamp says PUBLIC', () => {
    const active = ips('ALL_PUBLIC', 'PUBLIC');
    const draft = ips('ALL_PROTECTED', 'PUBLIC');

    expect(entityAuth(projectAuth(draft), entity('PUBLIC'))).toBe('PROTECTED');

    const report = analyseDraftImpact(active, draft);
    // The endpoints genuinely moved from open to closed, so they are affected.
    expect(report.affected.length).toBeGreaterThan(0);
    expect(report.artifacts).toContain('hosted_api');
  });

  /**
   * A whole-project mode change must enumerate its endpoints.
   *
   * This is the bug the invariant caught. `AUTH_MODE_CHANGED` is project-level,
   * so it named no entity and fell straight through to the artifact-only branch:
   * `affected: []`, `incomplete: false`, and **every endpoint listed under "No
   * impact"** — a confident, false claim about the single most breaking change
   * the product can make. `entityIds` is what fans it out.
   */
  it('enumerates every endpoint a whole-project mode change closes', () => {
    const report = analyseDraftImpact(ips('ALL_PUBLIC', 'PUBLIC'), ips('ALL_PROTECTED', 'PUBLIC'));

    // The fixture routes GET, POST and DELETE, and all three now need a token.
    const methods = report.affected.map((endpoint) => endpoint.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');

    // And nothing that changed may be sitting in the no-impact list, which is
    // the half that was actively misleading.
    const unaffectedPaths = report.unaffected.map((endpoint) => endpoint.path);
    expect(unaffectedPaths.some((path) => path.includes('payment'))).toBe(false);
  });

  it('fans out without dragging in the schema generators', () => {
    // The fan-out walks entity nodes, which is exactly where the `aspect: both`
    // mistake reseeded the mock store from. Routing edges must keep it to the
    // surface even across several entities.
    const report = analyseDraftImpact(ips('ALL_PUBLIC', 'PUBLIC'), ips('ALL_PROTECTED', 'PUBLIC'));
    expect(report.artifacts).not.toContain('zod');
    expect(report.artifacts).not.toContain('mock_data');
    expect(report.artifacts).not.toContain('typescript');
  });

  /**
   * Only the entities that moved. `COMBINATION → ALL_PROTECTED` leaves an
   * already-protected entity exactly as it was, and listing its endpoints as
   * affected would cost the precision the no-impact list exists to demonstrate.
   */
  it('leaves an already-protected entity out of the affected list', () => {
    const twoEntities = (mode: AuthMode): InternalProjectSchema => ({
      projectId: 'p1',
      version: 1,
      entities: [
        { ...entity('PROTECTED'), id: 'ent_locked', name: 'Order' },
        { ...entity('PUBLIC'), id: 'ent_open', name: 'Product' },
      ],
      generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 5 },
      authentication: config(mode),
    });

    const report = analyseDraftImpact(twoEntities('COMBINATION'), twoEntities('ALL_PROTECTED'));
    const paths = report.affected.map((endpoint) => endpoint.path);
    expect(paths.some((path) => path.includes('product'))).toBe(true);
    expect(paths.some((path) => path.includes('order'))).toBe(false);
  });

  it('reports no affected endpoints when the mode change closes nothing', () => {
    // NONE → ALL_PUBLIC adds an Auth API and protects nothing. Every business
    // endpoint is genuinely untouched, and saying otherwise would be the same
    // over-reporting in the other direction.
    const report = analyseDraftImpact(ips('NONE', undefined), ips('ALL_PUBLIC', undefined));
    expect(report.affected).toEqual([]);
    expect(report.artifacts).toContain('hosted_api');
  });

  it('reports no auth change when only a shadowed stamp moved', () => {
    // ALL_PROTECTED both sides, stamp flipped underneath. Nothing a caller can
    // observe changed, so nothing may be reported — and nothing regenerated.
    const changes = diffSchemas(ips('ALL_PROTECTED', 'PUBLIC'), ips('ALL_PROTECTED', 'PROTECTED'));
    expect(changes.filter((change) => change.kind === 'ENTITY_AUTH_CHANGED')).toEqual([]);
    expect(changes.filter((change) => change.kind === 'AUTH_MODE_CHANGED')).toEqual([]);
  });
});

/* ────────────── invariant 2: nothing else reads the field raw ────────────── */

/**
 * Files permitted to touch `.authentication` directly, each for a reason that is
 * not a protection decision.
 *
 * Adding a line here is a deliberate act. Anything determining whether a
 * request needs a token calls `entityAuth`/`projectAuth` instead — that is the
 * whole point of the resolver, and the reason this list is short.
 */
const ALLOWED: Record<string, string> = {
  'packages/ips/src/auth.ts':
    'owns the resolution: `entityAuth` is the one permitted reader, `stampEntityAuth` the one permitted writer',
  'packages/ips/src/validator.ts':
    "validates the raw value's shape before it is ever resolved — a shape check, not a protection decision",
  'packages/ips/src/types.ts': 'declares the field',
  /*
   * The client's mirror of this module.
   *
   * `apps/web` may not import `@instantmockapi/ips` (`web-must-not-import-server`),
   * so the resolution rule is restated there — and that file is the *only* place
   * in the web app permitted to read the field, exactly as `auth.ts` is here.
   * Every other web file calls `entityAuthOf`.
   *
   * What keeps the copy honest is `apps/web/src/lib/auth-config.test.ts`, which
   * pins the same 4×3 matrix `invariant 1` pins above. A divergence fails there.
   */
  'apps/web/src/lib/auth-config.ts':
    'owns the client-side resolution; pins the same matrix in its own test since it cannot import this module',
  /*
   * A pass-through, not a read for a decision.
   *
   * `parseBuilderRaw` lifts the wizard's answer off an untrusted payload and
   * hands it to the adapter, which puts it on the IPS — where `projectAuth`
   * reads it later. Nothing here compares it to a protection value.
   *
   * Destructuring it (`const { authentication } = builder`) would slip past the
   * regex without changing what the code does, so it is exempted honestly
   * instead. This is the third entry on the list, and every addition is a
   * little less protection: a broad pattern with reviewed exemptions still
   * beats a narrow one that would miss the two-line form of the mistake, but
   * the list is worth resisting.
   */
  'apps/api/src/input-parsing.ts':
    'passes the wizard payload’s auth block to the adapter; makes no protection decision',
  /*
   * The same pass-through as `input-parsing.ts`, for the other untrusted input.
   *
   * A blueprint arrives from outside the system and `normalizeBlueprint` puts
   * its auth block on the new IPS, where `projectAuth` reads it later. Nothing
   * compares it to a protection value, and the envelope key scan touches the
   * name only to refuse a credential hidden beside it.
   *
   * Routing it through `projectAuth` instead — which would satisfy the scan —
   * was considered and rejected: that returns a *defaulted* config, so storing
   * its output would rewrite the author's document on import and make a
   * blueprint round trip lossy. A lint rule is not worth changing what gets
   * stored.
   */
  'packages/ips/src/blueprint.ts':
    'passes an imported blueprint’s auth block onto the new IPS; makes no protection decision',
  /*
   * The same pass-through again, at the route that stores the input source.
   *
   * Both reads in that file copy a *validated blueprint's* project-level auth
   * config into `inputSource.raw` so `POST /projects/:id/parse` can re-read the
   * definition later. Neither compares it to a protection value and neither
   * touches an entity's own stamp.
   *
   * Unavoidable rather than merely convenient: the alternative is
   * `projectAuth`, which returns a *defaulted* config, so storing its output
   * would rewrite the author's document — the same reason
   * `packages/ips/src/blueprint.ts` is on this list.
   *
   * Worth noting for whoever reads this next: the entry arrived a stage after
   * the code did, because the scan is sensitive to how the expression is
   * formatted and a `prettier` pass changed it. That is a weakness of a
   * regex-based guard, not of the exemption.
   */
  'apps/api/src/routes/blueprint.ts':
    'copies a validated blueprint’s auth block into the stored input source; makes no protection decision',
};

/**
 * Scanned repo-wide, not just within this package.
 *
 * The developer most likely to write the wrong check is the one building the
 * runtime middleware or a generator, both of which live in other workspaces. A
 * guard hosted only in `packages/ips` would cover the code least likely to break
 * the rule. It reads files rather than importing anything, so the
 * `no-packages-importing-apps` boundary is untouched.
 */
const ROOT = join(process.cwd(), '..', '..');
const ROOTS = ['packages', 'apps'];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      // Tests are excluded on purpose: a fixture that *writes* the field, or a
      // test that reads it to assert the resolver's behaviour, is correct. The
      // invariant is about production code deciding access.
      found.push(path);
    }
  }
  return found;
}

const files = ROOTS.flatMap((name) => {
  const dir = join(ROOT, name);
  return existsSync(dir) ? sourceFiles(dir) : [];
}).map((path) => ({
  path: path.slice(ROOT.length + 1).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * A dotted read, so an object literal is not a match.
 *
 * `authentication: 'PUBLIC'` inside a fixture or a config object is a write and
 * carries no dot. `entity.authentication`, `ips.authentication` and
 * `project.ips.authentication` all do — and all three are the mistake.
 */
const RAW_READ = /\.authentication\b/;

/**
 * Strip comments before scanning.
 *
 * Without this the guard punishes documenting itself: a comment reading
 * *"never read `entity.authentication` directly"* is the most useful sentence a
 * file near this rule can contain, and it would fail the check that sentence
 * exists to explain. The first version of this test did exactly that to two
 * files, which is how the flaw was found.
 *
 * Deliberately naive — a `//` inside a string literal is stripped too. That
 * costs nothing here: the pattern being hunted is a property access, and there
 * is no reason for one to appear inside a string. Erring toward stripping means
 * the guard can only ever miss an offender, never invent one, and a missed
 * offender is caught by the behavioural tests above.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('invariant 2: the resolver is the only reader', () => {
  it('is scanning the repository at all', () => {
    // A guard that silently matches nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path === 'packages/ips/src/auth.ts')).toBe(true);
  });

  it('has no stale allowlist entry', () => {
    // A renamed file would leave a line here permitting nothing, while the logic
    // it once described moved somewhere unguarded.
    for (const path of Object.keys(ALLOWED)) {
      expect(
        files.find((file) => file.path === path),
        `${path} is allowlisted but no longer exists`,
      ).toBeDefined();
    }
  });

  it('reads entity.authentication nowhere but the resolver', () => {
    const offenders = files
      .filter((file) => ALLOWED[file.path] === undefined)
      .filter((file) => RAW_READ.test(withoutComments(file.text)))
      .map((file) => file.path);

    expect(
      offenders,
      [
        'Reading `.authentication` directly decides access from the entity alone,',
        'which is correct in COMBINATION mode and silently wrong in ALL_PROTECTED —',
        'where the field is absent by design and every entity would read as public.',
        '',
        'Use `entityAuth(projectAuth(ips), entity)` for effective protection, or',
        '`projectAuth(ips)` for the project configuration. If a file genuinely needs',
        'the raw value for something other than a protection decision, add it to',
        'ALLOWED with the reason.',
        '',
        offenders.join('\n'),
      ].join('\n'),
    ).toEqual([]);
  });

  /**
   * The other half of the same mistake: `ips.authentication` read raw is
   * `undefined` on every project written before Phase 3, so `.mode` throws and a
   * truthiness check reads a missing block as authentication being *off* —
   * which happens to be right, and `{ mode: 'NONE' }` as it being *on*, which is
   * not. `projectAuth` collapses both.
   */
  it('names projectAuth as the way to read the project block', () => {
    const guarded = files.find((file) => file.path === 'packages/ips/src/auth.ts');
    expect(guarded?.text).toContain('export function projectAuth');
    expect(guarded?.text).toContain('export function entityAuth');
  });
});

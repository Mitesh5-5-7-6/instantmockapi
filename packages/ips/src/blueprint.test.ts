import { describe, it, expect } from 'vitest';
import { goldenRelationsIPS } from '../__tests__/golden-relations-fixture.js';
import {
  BLUEPRINT_FORBIDDEN_KEYS,
  BLUEPRINT_SCHEMA_VERSION,
  BLUEPRINT_VERSION,
  blueprintFilename,
  blueprintVersionOf,
  buildBlueprint,
  migrateBlueprint,
  migrateToVersion,
  normalizeBlueprint,
  readBlueprint,
  validateBlueprint,
  type Blueprint,
  type BlueprintMigration,
} from './blueprint.js';
import { ensureSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
import type { InternalProjectSchema } from './types.js';

/**
 * Blueprints (Phase 4 §11–§16, §25, §26).
 *
 * Two claims carry most of this file:
 *
 * - **Read by whitelist.** A blueprint arrives from outside the system — a file
 *   a user was sent. Nothing it contains may reach the created project except
 *   the fields this module asks for by name. Most of the tests below are that
 *   claim under attack.
 * - **All or nothing.** §14 forbids a partial import, and the shape that makes
 *   that easy to keep true is a pipeline that either returns a ready definition
 *   or a structured reason. So every rejection is checked for *what it says*,
 *   not just that it failed: §14 asks for a path and a reason.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A definition with stable ids, as a live project's would have. */
function definition(): InternalProjectSchema {
  const ips = clone(goldenRelationsIPS);
  ensureSchemaIds(ips);
  return ips;
}

/**
 * The definition as a *stored* project holds it.
 *
 * The create path materializes before writing, so `project.ips` — the thing an
 * exporter actually reads — already carries the identity field and every
 * foreign key. Round-trip assertions have to start here: comparing an
 * un-materialized fixture against a round-tripped definition compares
 * materialization, not the round trip, and reports a difference that is
 * entirely expected.
 *
 * `materializeRelations` is idempotent, so the normalization step inside the
 * round trip is a no-op on this input and exact equality is the right claim.
 */
function storedDefinition(): InternalProjectSchema {
  return materializeRelations(definition());
}

/** A complete, valid `AuthConfig` — every field a real one carries. */
const authFixture = {
  mode: 'COMBINATION' as const,
  signup: true,
  signin: true,
  refreshToken: true,
  cookieAuth: true,
  accessTokenExpiresIn: '5m',
  refreshTokenExpiresIn: '30d',
  userFields: [{ name: 'displayName', type: 'string' as const, required: true }],
};

/** A well-formed blueprint of that definition. */
function blueprint(over: Partial<Blueprint> = {}): Blueprint {
  const ips = definition();
  return {
    blueprintVersion: BLUEPRINT_VERSION,
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    metadata: { sourceVersion: 7 },
    project: { name: 'School', description: 'Classes and students', kind: 'project' },
    entities: ips.entities,
    generationConfig: ips.generationConfig,
    ...over,
  };
}

const read = (raw: unknown, projectId = 'p_new') => readBlueprint(raw, { projectId });

/** Every `path` a failed result reported, for asserting §14's error shape. */
function paths(result: ReturnType<typeof read>): string[] {
  return result.ok ? [] : result.error.details.map((detail) => detail.path);
}

describe('§13: the version gate', () => {
  it('reads the version off a well-formed blueprint', () => {
    const result = blueprintVersionOf(blueprint());
    expect(result.ok && result.value).toBe(BLUEPRINT_VERSION);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', '{}'],
    ['a number', 3],
  ])('refuses %s as a blueprint', (_label, raw) => {
    const result = blueprintVersionOf(raw);
    expect(result.ok).toBe(false);
  });

  /**
   * §13: "Do not rely solely on the application version." A file with no
   * version is not a blueprint, and guessing that it is version 1 would mean
   * reading an unknown shape with the current rules.
   */
  it.each([
    ['no version', {}],
    ['a non-integer version', { blueprintVersion: 1.5 }],
    ['a zero version', { blueprintVersion: 0 }],
    ['a string version', { blueprintVersion: '1' }],
  ])('refuses %s', (_label, raw) => {
    const result = blueprintVersionOf(raw);
    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>)).toContain('blueprintVersion');
  });

  /**
   * A blueprint from a newer build. Refused with a message that says which way
   * round the mismatch is — "upgrade" and "this file is corrupt" are very
   * different next steps for a user.
   */
  it('refuses a newer format than this build understands', () => {
    const result = blueprintVersionOf({ blueprintVersion: BLUEPRINT_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('newer version of the platform');
      expect(result.error.details[0]?.issue).toContain('unsupported blueprint version');
    }
  });
});

describe('§13: migration', () => {
  it('leaves a current-format blueprint alone', () => {
    const source = blueprint();
    const result = migrateBlueprint(source);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual(source);
  });

  it('does not mutate the document it was given', () => {
    const source = blueprint();
    const before = clone(source);
    migrateBlueprint(source);
    expect(source).toEqual(before);
  });

  /**
   * The walk itself, against a target above the only format that exists.
   *
   * Version 1 is the floor and the ceiling today, so a walk aimed at
   * `BLUEPRINT_VERSION` never takes a step — every assertion about
   * `migrateBlueprint` alone would hold for an implementation that did nothing.
   * `migrateToVersion` is package-internal precisely so the mechanism can be
   * exercised now rather than first running for real on a user's file the day
   * version 2 ships.
   */
  it('applies each step in order, up to the target', () => {
    const seen: number[] = [];
    const migrations: Record<number, BlueprintMigration> = {
      1: (document) => {
        seen.push(1);
        return { ...document, blueprintVersion: 2, addedAtTwo: true };
      },
      2: (document) => {
        seen.push(2);
        return { ...document, blueprintVersion: 3, addedAtThree: true };
      },
    };

    const result = migrateToVersion(blueprint(), migrations, 3);

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    expect(seen).toEqual([1, 2]);
    if (result.ok) {
      expect(result.value['blueprintVersion']).toBe(3);
      expect(result.value['addedAtTwo']).toBe(true);
      expect(result.value['addedAtThree']).toBe(true);
      // The definition survives the walk.
      expect(result.value['project']).toEqual(blueprint().project);
    }
  });

  it('stops as soon as it reaches the target', () => {
    const seen: number[] = [];
    const migrations: Record<number, BlueprintMigration> = {
      1: (document) => {
        seen.push(1);
        return { ...document, blueprintVersion: 2 };
      },
      2: (document) => {
        seen.push(2);
        return { ...document, blueprintVersion: 3 };
      },
    };

    const result = migrateToVersion(blueprint(), migrations, 2);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([1]);
  });

  /**
   * A format with no migration is refused, not imported as-is.
   *
   * Reading a version-1 document with version-3 rules is exactly the silent
   * corruption blueprint versioning exists to prevent, so a missing step has to
   * be an error rather than a skip.
   */
  it('refuses a gap in the ladder rather than importing an unmigrated file', () => {
    const result = migrateToVersion(blueprint(), { 2: (d) => d }, 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.issue).toContain('no migration from blueprint version 1');
    }
  });

  /**
   * A migration that forgets to bump the version would spin forever.
   *
   * Worth its own guard because the failure mode is a hung request rather than
   * an error — and forgetting one line is exactly the mistake a future
   * migration makes.
   */
  it('refuses a migration that does not advance the version', () => {
    const stuck: Record<number, BlueprintMigration> = {
      1: (document) => ({ ...document, blueprintVersion: 1 }),
    };

    const result = migrateToVersion(blueprint(), stuck, 2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('did not advance');
    }
  });

  it('refuses a migration that moves the version backwards', () => {
    const backwards: Record<number, BlueprintMigration> = {
      1: (document) => ({ ...document, blueprintVersion: 0 }),
    };

    expect(migrateToVersion(blueprint(), backwards, 2).ok).toBe(false);
  });

  it('refuses a migration that drops the version entirely', () => {
    const dropped: Record<number, BlueprintMigration> = {
      1: (document) => {
        const next = { ...document };
        delete next['blueprintVersion'];
        return next;
      },
    };

    expect(migrateToVersion(blueprint(), dropped, 2).ok).toBe(false);
  });
});

describe('§13: envelope validation', () => {
  it('accepts a well-formed blueprint', () => {
    expect(validateBlueprint(blueprint()).ok).toBe(true);
  });

  it('accepts one with no authentication block', () => {
    const source = blueprint();
    delete source.authentication;
    expect(validateBlueprint(source).ok).toBe(true);
  });

  it.each([
    ['schemaVersion', 'schemaVersion'],
    ['metadata', 'metadata'],
    ['project', 'project'],
    ['entities', 'entities'],
    ['generationConfig', 'generationConfig'],
  ])('requires %s', (_label, key) => {
    const source = blueprint() as unknown as Record<string, unknown>;
    delete source[key];
    const result = validateBlueprint(source);

    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>)).toContain(key);
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateBlueprint({
      blueprintVersion: BLUEPRINT_VERSION,
      // schemaVersion, metadata, project, entities and generationConfig all absent.
    });

    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>).sort()).toEqual([
      'entities',
      'generationConfig',
      'metadata',
      'project',
      'schemaVersion',
    ]);
  });

  it('refuses an unknown project kind', () => {
    const result = validateBlueprint(
      blueprint({ project: { name: 'X', kind: 'enterprise' as never } }),
    );

    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>)).toContain('project.kind');
  });

  it('refuses a blank project name', () => {
    const result = validateBlueprint(blueprint({ project: { name: '   ', kind: 'project' } }));
    expect(paths(result as ReturnType<typeof read>)).toContain('project.name');
  });

  it('refuses a source version that is not a positive integer', () => {
    const result = validateBlueprint(blueprint({ metadata: { sourceVersion: 0 } }));
    expect(paths(result as ReturnType<typeof read>)).toContain('metadata.sourceVersion');
  });

  /** §14's error shape: a path and a reason, on every detail. */
  it('reports a path and a reason for every problem', () => {
    const result = validateBlueprint({ blueprintVersion: BLUEPRINT_VERSION });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details.length).toBeGreaterThan(0);
      for (const detail of result.error.details) {
        expect(detail.path, JSON.stringify(detail)).not.toBe('');
        expect(detail.issue.length, JSON.stringify(detail)).toBeGreaterThan(3);
      }
    }
  });
});

describe('§12/§16: credentials are refused, not laundered', () => {
  /**
   * A blueprint is "safe to export and share" (§12). Enforcing that on the way
   * *in* as well means a file from a non-conforming exporter is refused rather
   * than quietly stripped — the person holding it learns their file contains a
   * key, which is the only way they will rotate it.
   */
  it.each([...BLUEPRINT_FORBIDDEN_KEYS])('refuses %s at the root', (key) => {
    const source = { ...blueprint(), [key]: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const result = validateBlueprint(source);

    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>)).toContain(key);
  });

  it('refuses a signing key hidden in the authentication block', () => {
    const source = blueprint({
      authentication: {
        mode: 'ALL_PROTECTED',
        signup: true,
        signin: true,
        refreshToken: true,
        cookieAuth: false,
        accessTokenExpiresIn: '15m',
        refreshTokenExpiresIn: '7d',
        userFields: [],
        signingKey: 'deadbeef',
      } as never,
    });
    const result = validateBlueprint(source);

    expect(result.ok).toBe(false);
    expect(paths(result as ReturnType<typeof read>)).toContain('authentication.signingKey');
  });

  it('refuses one hidden in metadata', () => {
    const source = blueprint({
      metadata: { sourceVersion: 1, accessToken: 'ey.J' } as never,
    });
    expect(paths(validateBlueprint(source) as ReturnType<typeof read>)).toContain(
      'metadata.accessToken',
    );
  });

  /**
   * The user's own schema is not a credential.
   *
   * A data model may legitimately contain a field called `secret` or `apiKey` —
   * that is what the project is *for* — and refusing to import it would be
   * refusing a valid project. §12's list describes the blueprint's structure,
   * not the definition inside it, so the key scan stops at the envelope.
   */
  it('imports an entity whose own field is called secret', () => {
    const ips = definition();
    ips.entities[0]!.fields.push({
      id: 'fld_userowned',
      name: 'apiKey',
      type: 'string',
      required: false,
      default: null,
      validation: {},
      meta: {},
      children: [],
    });

    const result = read(blueprint({ entities: ips.entities }));
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    if (result.ok) {
      const names = result.value.ips.entities[0]!.fields.map((field) => field.name);
      expect(names).toContain('apiKey');
    }
  });
});

describe('§15: what a blueprint may not name', () => {
  /**
   * A blueprint that could name its own project id could alias another
   * project — so the id comes from the caller, and the key is refused outright
   * rather than ignored.
   */
  it.each(['projectId', 'publicId', 'slug', 'ownerId'])('refuses %s', (key) => {
    const result = validateBlueprint({ ...blueprint(), [key]: 'stolen' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const detail = result.error.details.find((entry) => entry.path === key);
      expect(detail?.issue).toContain('assigned when the project is created');
    }
  });

  it('takes the project id from the caller', () => {
    const result = read(blueprint(), 'p_caller');
    expect(result.ok && result.value.ips.projectId).toBe('p_caller');
  });

  /**
   * An import creates a *new* project, which starts at v1. The source's version
   * travels as metadata and stays informational — a project that began life at
   * v7 would have six versions nobody can compare against.
   */
  it('starts the imported definition at version 1, whatever the source was', () => {
    const result = read(blueprint({ metadata: { sourceVersion: 42 } }));
    expect(result.ok && result.value.ips.version).toBe(1);
  });
});

describe('normalizeBlueprint on its own', () => {
  /**
   * Called directly, without the version gate or the envelope check.
   *
   * That is a real caller, not a test convenience: Duplicate Project (§19)
   * builds a blueprint in memory from a project it already owns, so there is no
   * file to have come from a newer build and nothing to migrate. It still has
   * to go through normalization, because that is where the canonical rules and
   * the new project id are applied.
   */
  it('produces a ready definition from a blueprint already in hand', () => {
    const result = normalizeBlueprint(blueprint(), { projectId: 'p_dup' });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    if (result.ok) {
      expect(result.value.projectId).toBe('p_dup');
      expect(result.value.version).toBe(1);
      expect(result.value.entities.length).toBeGreaterThan(0);
    }
  });

  /**
   * It validates on its own, so a caller cannot skip that step.
   *
   * §13's flow lists normalization and canonical validation separately, and
   * they are collapsed here deliberately: an unvalidated IPS that a caller
   * might forget to check is the value that makes "never partially import an
   * invalid blueprint" hard to keep true. There is no code path that produces
   * one.
   */
  it('refuses an invalid definition rather than returning it unchecked', () => {
    const source = definition();
    source.entities[0]!.name = '9-not-an-identifier';

    const result = normalizeBlueprint(blueprint({ entities: source.entities }), {
      projectId: 'p_dup',
    });
    expect(result.ok).toBe(false);
  });
});

describe('normalization reads by whitelist', () => {
  /**
   * The invariant the whole module rests on, tested the way it would actually
   * break: a blueprint carrying keys the IPS happens to have.
   *
   * A `{ ...blueprint }` implementation passes every other test in this file
   * and fails this one.
   */
  it('copies no key it was not asked for', () => {
    const hostile = {
      ...blueprint(),
      hosted: { url: 'https://evil.example/attacker' },
      status: 'active',
      currentVersion: 99,
      publishedVersion: 99,
      ownerId: undefined,
      injected: 'nope',
    };
    // `ownerId: undefined` rather than a value, so the envelope check passes and
    // what is under test is the *copying*, not the rejection.
    delete (hostile as Record<string, unknown>)['ownerId'];

    const result = read(hostile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.value.ips).sort();
      expect(keys).toEqual(['entities', 'generationConfig', 'kind', 'projectId', 'version']);
    }
  });

  it('carries the definition itself across intact', () => {
    const source = definition();
    const result = read(blueprint({ entities: source.entities }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ips.entities.map((entity) => entity.name)).toEqual(
        source.entities.map((entity) => entity.name),
      );
      expect(result.value.ips.generationConfig).toEqual(source.generationConfig);
    }
  });

  /**
   * §12: "Preserve stable IDs where they are part of the canonical
   * definition." They are: the diff engine pairs entities and fields by id, so
   * a duplicated project whose ids were re-minted could not be compared against
   * the original in any useful way.
   */
  it('preserves stable ids', () => {
    const source = definition();
    const result = read(blueprint({ entities: source.entities }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ips.entities.map((entity) => entity.id)).toEqual(
        source.entities.map((entity) => entity.id),
      );
    }
  });

  /**
   * Two entities sharing one id is silent and late: the diff engine pairs by
   * id, so a version comparison would compare an entity against its twin and
   * report changes nobody made. `validateIPS` cannot catch it — nothing it
   * validates can produce a duplicate, because ids are minted from random
   * bytes — so a blueprint is the only way one arrives.
   */
  it('refuses duplicate stable ids', () => {
    const source = definition();
    const [first, second] = source.entities;
    if (first === undefined || second === undefined) {
      throw new Error('fixture shape changed');
    }
    second.id = first.id;

    const result = read(blueprint({ entities: source.entities }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('duplicate stable ids');
      expect(result.error.details[0]?.issue).toContain(String(first.id));
    }
  });

  it('derives the identity and foreign-key fields, as the create path does', () => {
    const source = definition();
    // Strip what materialization adds, leaving only what an author wrote.
    for (const entity of source.entities) {
      entity.fields = entity.fields.filter(
        (field) => field.name !== 'id' && !field.name.endsWith('Id'),
      );
    }

    const result = read(blueprint({ entities: source.entities }));
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    if (result.ok) {
      expect(result.value.ips.entities[0]!.fields.some((field) => field.name === 'id')).toBe(true);
    }
  });
});

describe('§16: authentication configuration is portable', () => {
  // The same complete config the export tests use, so the two halves of the
  // round trip are asserted against one fixture rather than two that can drift.
  const authConfig = authFixture;

  it('carries the configuration across', () => {
    const result = read(blueprint({ authentication: authConfig }));

    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    expect(result.ok && result.value.ips.authentication).toEqual(authConfig);
  });

  /**
   * The guard on the collision that this module shipped with, briefly.
   *
   * `AuthConfig.refreshToken` is a boolean flag — whether a `POST /refresh`
   * endpoint is generated — and it shares its name with the credential that
   * endpoint returns. The credential-name list therefore rejected every valid
   * blueprint of an auth-enabled project.
   *
   * This asserts the general case rather than that one key: every key of a
   * valid `AuthConfig` must survive the envelope check. A future config field
   * that collides with a credential name then arrives as a failing test rather
   * than as a user who cannot export their project.
   */
  it('accepts every key a valid AuthConfig carries', () => {
    for (const key of Object.keys(authConfig)) {
      const result = validateBlueprint(blueprint({ authentication: authConfig }));
      const offending = result.ok
        ? []
        : result.error.details.filter((detail) => detail.path === `authentication.${key}`);

      expect(offending, `authentication.${key} was refused: ${JSON.stringify(offending)}`).toEqual(
        [],
      );
    }
  });

  /**
   * "Never configured" and "configured off" must stay the same document.
   *
   * `parseBuilderPayload` omits a `NONE` block for this reason, and a blueprint
   * has to agree: if an import wrote `{ mode: 'NONE' }` where the source had
   * nothing, the imported project's first diff would show an
   * `AUTH_MODE_CHANGED` that nobody made.
   */
  it('omits a NONE block rather than storing it', () => {
    const result = read(blueprint({ authentication: { ...authConfig, mode: 'NONE' } }));

    expect(result.ok).toBe(true);
    expect(result.ok && 'authentication' in result.value.ips).toBe(false);
  });

  it('refuses a malformed authentication block through validateIPS', () => {
    const result = read(
      blueprint({ authentication: { ...authConfig, mode: 'SOMETIMES' } as never }),
    );

    expect(result.ok).toBe(false);
    expect(paths(result).some((path) => path.startsWith('authentication'))).toBe(true);
  });
});

describe('§13/§14: the pipeline refuses before it produces anything', () => {
  it('runs the whole flow for a good blueprint', () => {
    const result = read(blueprint());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.project.name).toBe('School');
      expect(result.value.ips.projectId).toBe('p_new');
    }
  });

  /**
   * The definition is validated by `validateIPS`, not by a second copy of its
   * rules here — so a malformed field type is reported with the path
   * `validateIPS` gives it, which is the same path the editor and the create
   * route report. §14: do not create a second error system.
   */
  it('refuses a malformed field type, with the canonical path', () => {
    const source = definition();
    source.entities[0]!.fields[0]!.type = 'timestamp' as never;

    const result = read(blueprint({ entities: source.entities }));
    expect(result.ok).toBe(false);
    expect(paths(result).some((path) => /^entities\[0\]\.fields\[0\]\.type$/.test(path))).toBe(
      true,
    );
  });

  it('refuses a relationship pointing at no entity', () => {
    const source = definition();
    source.entities[0]!.relations = [
      { id: 'rel_bad', name: 'ghost', kind: 'hasMany', target: 'Nowhere', onDelete: 'cascade' },
    ];

    const result = read(blueprint({ entities: source.entities }));
    expect(result.ok).toBe(false);
    expect(paths(result).length).toBeGreaterThan(0);
  });

  it('refuses an empty entity list for a project that needs one', () => {
    const result = read(blueprint({ entities: [] }));
    expect(result.ok).toBe(false);
  });

  /**
   * An Auth API project legitimately has no entities — its surface is the Auth
   * API — and `validateIPS` waives the at-least-one-entity rule for that kind
   * alone. So the kind has to be set before validation, which is why
   * `normalizeBlueprint` assembles it into the IPS rather than stamping it on
   * afterwards.
   */
  it('accepts an Auth API blueprint with no entities', () => {
    const result = read(
      blueprint({
        project: { name: 'Just auth', kind: 'auth' },
        entities: [],
        authentication: {
          mode: 'ALL_PROTECTED',
          signup: true,
          signin: true,
          refreshToken: true,
          cookieAuth: false,
          accessTokenExpiresIn: '15m',
          refreshTokenExpiresIn: '7d',
          userFields: [],
        },
      }),
    );

    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
    expect(result.ok && result.value.ips.kind).toBe('auth');
  });

  it('validates before migrating would have been wrong, so it migrates first', () => {
    // A newer format never reaches envelope validation: it is refused by the
    // gate, with the version as the reason rather than a list of shape errors
    // produced by reading a shape this build does not know.
    const result = read({ ...blueprint(), blueprintVersion: BLUEPRINT_VERSION + 1 });

    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual(['blueprintVersion']);
  });

  it('does not mutate the blueprint it was handed', () => {
    const source = blueprint();
    const before = clone(source);
    read(source);
    expect(source).toEqual(before);
  });
});

describe('§12/§17: export', () => {
  const exported = (over: Partial<InternalProjectSchema> = {}) =>
    buildBlueprint({ ...definition(), ...over }, { name: 'School', description: 'Classes' });

  it('produces a blueprint its own validator accepts', () => {
    const result = validateBlueprint(exported());
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error.details)).toBe(true);
  });

  it('stamps the format and the source version', () => {
    const blueprintOut = exported({ version: 9 });

    expect(blueprintOut.blueprintVersion).toBe(BLUEPRINT_VERSION);
    expect(blueprintOut.schemaVersion).toBe(BLUEPRINT_SCHEMA_VERSION);
    expect(blueprintOut.metadata.sourceVersion).toBe(9);
  });

  it('carries the project facts that live outside the definition', () => {
    const blueprintOut = exported();

    expect(blueprintOut.project.name).toBe('School');
    expect(blueprintOut.project.description).toBe('Classes');
    expect(blueprintOut.project.kind).toBe('project');
  });

  it('defaults the kind rather than omitting it', () => {
    // Pre-Phase-3 definitions carry no `kind`; the surface they generate is the
    // Project API, so that is what a blueprint of one has to say.
    const source = definition();
    delete source.kind;
    expect(buildBlueprint(source, { name: 'X' }).project.kind).toBe('project');
  });

  /**
   * §12's "do not include" list, enforced by construction rather than by
   * stripping.
   *
   * The IPS handed to the exporter routinely *does* carry addressing — the
   * documentation route overlays `publicId` and `slug` on purpose — so this is
   * the realistic input, not a contrived one.
   */
  it('carries no project or runtime field, even when the definition has them', () => {
    const blueprintOut = buildBlueprint(
      {
        ...definition(),
        publicId: 'prj_secret01',
        slug: 'live-shop',
      } as InternalProjectSchema,
      { name: 'School' },
    );

    expect(Object.keys(blueprintOut).sort()).toEqual([
      'blueprintVersion',
      'entities',
      'generationConfig',
      'metadata',
      'project',
      'schemaVersion',
    ]);
    const serialized = JSON.stringify(blueprintOut);
    expect(serialized).not.toContain('prj_secret01');
    expect(serialized).not.toContain('live-shop');
    expect(serialized).not.toContain('projectId');
  });

  /**
   * A blueprint of an addressed project must be importable.
   *
   * The two halves have to agree: the import side *rejects* `publicId` and
   * `slug`, so an exporter that emitted them would produce files that only
   * failed at the moment someone tried to use them.
   */
  it('round-trips a definition that carries addressing', () => {
    const blueprintOut = buildBlueprint(
      { ...definition(), publicId: 'prj_abc', slug: 'shop' } as InternalProjectSchema,
      { name: 'School' },
    );

    expect(read(blueprintOut).ok).toBe(true);
  });

  /**
   * No clock, so two exports of an unchanged project are the same bytes.
   *
   * That is what lets a user diff two blueprints and see only what changed, and
   * it is why `exportedAt` is opt-in.
   */
  it('exports byte-identically twice', () => {
    const source = definition();
    expect(JSON.stringify(buildBlueprint(source, { name: 'School' }))).toEqual(
      JSON.stringify(buildBlueprint(source, { name: 'School' })),
    );
  });

  it('stamps a time only when the caller supplies one', () => {
    expect(exported().metadata.exportedAt).toBeUndefined();
    expect(
      buildBlueprint(definition(), { name: 'X', exportedAt: '2026-09-09T00:00:00.000Z' }).metadata
        .exportedAt,
    ).toBe('2026-09-09T00:00:00.000Z');
  });

  it('does not alias the definition it was given', () => {
    const source = definition();
    const blueprintOut = buildBlueprint(source, { name: 'School' });

    source.entities[0]!.name = 'Renamed';
    expect(blueprintOut.entities[0]!.name).not.toBe('Renamed');
  });

  it('omits an authentication block the definition does not have', () => {
    const source = definition();
    delete source.authentication;
    expect('authentication' in buildBlueprint(source, { name: 'X' })).toBe(false);
  });

  it('omits a NONE block, so a round trip shows no change', () => {
    const source = definition();
    source.authentication = { ...authFixture, mode: 'NONE' };
    expect('authentication' in buildBlueprint(source, { name: 'X' })).toBe(false);
  });

  it('carries an enabled authentication configuration across', () => {
    const source = definition();
    source.authentication = authFixture;
    expect(buildBlueprint(source, { name: 'X' }).authentication).toEqual(authFixture);
  });
});

describe('§12/§26: a polluted definition still exports safely', () => {
  /**
   * `parseBuilderPayload` passes the wizard payload's `authentication` block
   * straight through and `validateAuth` does not reject keys it does not know,
   * so a project can genuinely hold a stray credential-named key in its auth
   * block. §12 requires the *produced file* to be safe to share, so the
   * exporter omits it rather than emitting it and leaving the import side to
   * refuse the result.
   */
  it('omits a credential-named key the stored definition carries', () => {
    const source = definition();
    source.authentication = {
      ...authFixture,
      signingKey: 'a3f9c1e07b4d28650f1a9c3e7d5b8402',
    } as never;

    const blueprintOut = buildBlueprint(source, { name: 'X' });
    const serialized = JSON.stringify(blueprintOut);

    expect(serialized).not.toContain('signingKey');
    expect(serialized).not.toContain('a3f9c1e07b4d28650f1a9c3e7d5b8402');
    // And the file it produced is importable, which emitting the key would have
    // prevented — the two sides use one list.
    expect(read(blueprintOut).ok).toBe(true);
  });

  /**
   * The exemption has to hold in both directions.
   *
   * `authentication.refreshToken` is a configuration flag that shares a
   * credential's name. Import allows it; export must not drop it, or importing
   * the file would turn the project's `/refresh` endpoint off.
   */
  it('keeps the refreshToken flag, which only shares a credential name', () => {
    const source = definition();
    source.authentication = { ...authFixture, refreshToken: true };

    const blueprintOut = buildBlueprint(source, { name: 'X' });
    expect(blueprintOut.authentication?.refreshToken).toBe(true);

    const back = read(blueprintOut);
    expect(back.ok && back.value.ips.authentication?.refreshToken).toBe(true);
  });

  it('omits a credential-named key from generationConfig', () => {
    const source = definition();
    source.generationConfig = { ...source.generationConfig, apiKey: 'nope' } as never;

    expect(JSON.stringify(buildBlueprint(source, { name: 'X' }))).not.toContain('apiKey');
  });
});

describe('§25: export/import round trip preserves semantics', () => {
  /**
   * The claim §25 actually makes, checked end to end at the definition level:
   * export a definition, read it back as a new project, and nothing about the
   * project's *meaning* has moved. Only the two things that must differ do.
   */
  it('preserves the definition through export and back', () => {
    const source = storedDefinition();
    source.authentication = authFixture;

    const back = read(buildBlueprint(source, { name: 'School' }), 'p_imported');
    expect(back.ok, back.ok ? '' : JSON.stringify(back.error.details)).toBe(true);
    if (!back.ok) {
      return;
    }

    // Identity and lineage change, and only those.
    expect(back.value.ips.projectId).toBe('p_imported');
    expect(back.value.ips.version).toBe(1);

    // Everything that describes the project is unchanged.
    expect(back.value.ips.entities).toEqual(source.entities);
    expect(back.value.ips.generationConfig).toEqual(source.generationConfig);
    expect(back.value.ips.authentication).toEqual(source.authentication);
    expect(back.value.ips.kind).toEqual(source.kind ?? 'project');
  });

  /**
   * Stable ids survive, which is what makes a duplicated project comparable
   * against its original: the diff engine pairs entities and fields by id.
   */
  it('preserves every stable id', () => {
    const source = storedDefinition();
    const back = read(buildBlueprint(source, { name: 'School' }));

    expect(back.ok).toBe(true);
    if (back.ok) {
      const ids = (ips: InternalProjectSchema) =>
        ips.entities.flatMap((entity) => [
          entity.id,
          ...entity.fields.map((field) => field.id),
          ...(entity.relations ?? []).map((relation) => relation.id),
        ]);
      expect(ids(back.value.ips)).toEqual(ids(source));
    }
  });

  /**
   * Twice through the cycle changes nothing further.
   *
   * A round trip that is not idempotent is one that loses or adds something on
   * each pass — materialization re-running, a default being filled in — and the
   * second lap is where that shows.
   */
  it('is idempotent across two full cycles', () => {
    const source = storedDefinition();
    source.authentication = authFixture;

    const first = read(buildBlueprint(source, { name: 'School' }), 'p_one');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = read(buildBlueprint(first.value.ips, { name: 'School' }), 'p_one');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.ips).toEqual(first.value.ips);
    }
  });

  it('round-trips an Auth API project with no entities', () => {
    const back = read(
      buildBlueprint(
        {
          projectId: 'p_src',
          version: 3,
          kind: 'auth',
          entities: [],
          authentication: authFixture,
          generationConfig: definition().generationConfig,
        },
        { name: 'Just auth' },
      ),
    );

    expect(back.ok, back.ok ? '' : JSON.stringify(back.error.details)).toBe(true);
    expect(back.ok && back.value.ips.kind).toBe('auth');
    expect(back.ok && back.value.ips.entities).toEqual([]);
  });
});

describe('§17: the download filename', () => {
  it('names the file after the project, with the suffix §17 writes', () => {
    expect(blueprintFilename({ slug: 'shop' })).toBe('shop.blueprint.json');
  });

  it('falls back to the literal §17 writes when there is no slug', () => {
    expect(blueprintFilename({})).toBe('project.blueprint.json');
    expect(blueprintFilename({ slug: null })).toBe('project.blueprint.json');
  });

  it('never produces a name that is only punctuation', () => {
    expect(blueprintFilename({ slug: '///' })).toBe('project.blueprint.json');
  });

  /**
   * The literals the web app's mirror pins too.
   *
   * `apps/web/src/lib/notes-document.ts` cannot import this function —
   * `web-must-not-import-server` — and needs the name client-side, because it
   * downloads from the parsed body rather than following the
   * `content-disposition` header. So the rule exists twice, and pinning the
   * same cases on both sides is what makes a drift visible. One already
   * happened: this side did not lowercase, so a mixed-case slug produced two
   * different filenames.
   */
  it('lowercases and slugs, matching the client mirror', () => {
    expect(blueprintFilename({ slug: 'My Shop' })).toBe('my-shop.blueprint.json');
    expect(blueprintFilename({ slug: 'Shop_2' })).toBe('shop-2.blueprint.json');
  });
});

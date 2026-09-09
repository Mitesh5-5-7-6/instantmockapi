/**
 * Blueprints — the portable form of a canonical definition (Phase 4 §11–§16).
 *
 *     Raw JSON → version gate → migrate → validate → normalize → IPS
 *
 * A blueprint is everything needed to recreate a project and nothing else. It
 * lives in `packages/ips` because that is where the canonical definition and
 * its validator live: a blueprint is that definition serialised, so putting its
 * rules anywhere else would mean two packages deciding what a valid project is.
 *
 * ## The one invariant everything here rests on: read by whitelist
 *
 * Nothing in this module spreads its input. Every field of the produced IPS is
 * assigned by name, exactly as `parseBuilderPayload` does for the wizard. That
 * is what makes a blueprint safe to accept from outside: a file cannot inject a
 * key into a project by inventing one, because nothing copies keys it was not
 * asked for.
 *
 * The alternative — `{ ...blueprint, projectId }` — would work today and would
 * quietly become an injection the moment the IPS grew a field. `projectAuth`
 * uses the same whitelist discipline for the same reason.
 *
 * ## What is deliberately not in a blueprint
 *
 * **Addressing.** `publicId` and `slug` are properties of a *deployment*, not
 * of a definition. `slug` is uniquely indexed per owner, so a blueprint
 * carrying one could not be imported into the account it came from — which is
 * precisely the Duplicate Project case (§19). They are rejected rather than
 * ignored, so nobody is left believing their base path transferred.
 *
 * **`projectId`.** Assigned by the importer (§15). A blueprint that could name
 * its own project id is a blueprint that could alias someone else's project.
 *
 * **Credentials of any kind.** §12 lists them and §16 is explicit: auth
 * *configuration* is portable, auth *secrets* are not. This module rejects them
 * on the way in as well, so a file produced by a non-conforming exporter is
 * refused rather than silently laundered.
 *
 * **Derived endpoints.** §12's tree names "endpoint configuration", which in
 * this codebase does not exist as stored data: endpoints are derived from
 * entities and `generationConfig.methods` by `projectEndpoints`, and Phase 2
 * deliberately left `ep_` unminted. Storing an endpoint list would create a
 * second source of truth that can disagree with the entities it came from. The
 * configuration that actually decides the endpoint surface — methods, query
 * features, per-entity authentication — is all here.
 *
 * **Runtime state.** No artifacts, no mock records, no job history, no hosted
 * URL, no version rows. §12 forbids them and §22 keeps the definition and the
 * runtime separate; a blueprint is the definition.
 *
 * ## Fields and relationships are nested, not flat
 *
 * §12's tree lists `entities`, `fields` and `relationships` as siblings. That
 * is the conceptual inventory, not a literal shape: in the IPS, fields and
 * relations live inside their entity, and flattening them here would create a
 * second representation that has to be re-nested on import. One shape, reused.
 */

import {
  AppError,
  PROJECT_KINDS,
  err,
  ok,
  type ErrorDetail,
  type ProjectKind,
  type Result,
} from '@instantmockapi/shared';
import { duplicateSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
import { validateIPS } from './validator.js';
import type { AuthConfig, Entity, GenerationConfig, InternalProjectSchema } from './types.js';

/* ────────────────────────── the format ────────────────────────── */

/**
 * The blueprint format's own version, bumped when its *shape* changes.
 *
 * §13: "Do not rely solely on the application version." A blueprint outlives
 * the build that wrote it — it is a file a user keeps — so the file has to say
 * what it is. An integer, because migrations step through it.
 */
export const BLUEPRINT_VERSION = 1;

/**
 * The canonical-definition contract this blueprint's `entities` conform to.
 *
 * Separate from `blueprintVersion` because the two move independently: the
 * envelope can gain a field without the definition changing, and the definition
 * can gain a field type without the envelope changing. `1.x` rather than `1.0`
 * — the minor is deliberately unpinned, since a definition change that needs a
 * new *major* is the case that must be refused.
 */
export const BLUEPRINT_SCHEMA_VERSION = '1.x';

export interface BlueprintMetadata {
  /**
   * The definition version this blueprint was taken from. Informational.
   *
   * Never becomes the imported project's version — an import creates a new
   * project, which starts at v1 (§15). It is here because "this came from v7"
   * is the first thing a person opening the file wants to know.
   */
  sourceVersion: number;
  /**
   * When it was exported, if the caller chose to stamp one.
   *
   * Optional and never read on import. Optional because this module is pure —
   * no clock — and because a stamped blueprint cannot be byte-compared against
   * a re-export, which is how the round-trip guarantee (§25) is checked.
   */
  exportedAt?: string;
}

export interface BlueprintProject {
  name: string;
  description?: string | null;
  /** `project` | `single` | `auth` — decides which surface is generated. */
  kind: ProjectKind;
}

export interface Blueprint {
  blueprintVersion: number;
  schemaVersion: string;
  metadata: BlueprintMetadata;
  project: BlueprintProject;
  /** Fields and relations nested inside each entity, as the IPS stores them. */
  entities: Entity[];
  /** Configuration only. There is no field here for a signing key (§16). */
  authentication?: AuthConfig;
  generationConfig: GenerationConfig;
}

/**
 * Keys a blueprint's *envelope* must never carry.
 *
 * Scoped to the envelope — the root, `project`, `metadata`, `authentication`
 * and `generationConfig` — and deliberately **not** applied to `entities`. A
 * user's data model may legitimately contain a field called `secret` or
 * `apiKey`; that is their schema, not a leaked credential, and refusing to
 * import it would be refusing to import a valid project. §12's list is about
 * the blueprint's own structure.
 *
 * Exported so an exporter can be tested against the same list rather than a
 * copy of it.
 */
export const BLUEPRINT_FORBIDDEN_KEYS: readonly string[] = [
  'secret',
  'secrets',
  'signingKey',
  'jwtSecret',
  'authSecret',
  'apiKey',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'passwordHash',
  'password',
  'sessionHash',
  'connectionString',
  'connectionUri',
  'mongoUri',
  'redisUrl',
];

/**
 * Keys that name a *project* rather than a definition.
 *
 * Rejected with their own message, because the remedy differs: a credential in
 * a blueprint means the file is unsafe, whereas `slug` means the file is
 * describing a deployment it cannot bring with it.
 */
const BLUEPRINT_ASSIGNED_KEYS: readonly string[] = ['projectId', 'publicId', 'slug', 'ownerId'];

/**
 * Envelope keys that collide with a credential name but are configuration.
 *
 * `authentication.refreshToken` is an `AuthConfig` **flag** — whether the
 * project generates a `POST /refresh` endpoint — and it shares its name with
 * the credential that endpoint returns. Without this exemption the forbidden
 * list rejects every valid blueprint of an auth-enabled project, which is how
 * it was first written.
 *
 * A named exemption rather than a rule about value types ("a credential is
 * always a string"), because it fails safe: if `AuthConfig` grows another
 * colliding flag, blueprints of those projects are refused until someone adds
 * it here — and `blueprint.test.ts` asserts every key of a valid `AuthConfig`
 * survives this check, so that day arrives as a failing test rather than as a
 * user unable to export.
 */
const ENVELOPE_KEY_EXEMPTIONS: ReadonlySet<string> = new Set(['authentication.refreshToken']);

/* ────────────────────────── version gate ────────────────────────── */

/**
 * Read and vet the version, before anything tries to read the shape.
 *
 * §13's flow reads "validate blueprintVersion → validate schema → migrate".
 * Taken literally that cannot work: a version-0 document validated against the
 * version-1 schema fails before the migration that would have fixed it. So the
 * order here is *gate the version, migrate to current, then validate the
 * shape*, which is what §13's flow means — and the literal reading would make
 * `migrateBlueprint` unreachable for exactly the documents it exists for.
 */
export function blueprintVersionOf(raw: unknown): Result<number, AppError> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: 'A blueprint must be a JSON object',
      }),
    );
  }

  const version = (raw as { blueprintVersion?: unknown }).blueprintVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: 'This file is not a blueprint, or is missing its version',
        details: [
          {
            path: 'blueprintVersion',
            issue: 'blueprintVersion must be an integer of 1 or more',
          },
        ],
      }),
    );
  }

  if (version > BLUEPRINT_VERSION) {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: `This blueprint was written by a newer version of the platform (format ${version}; this build reads up to ${BLUEPRINT_VERSION})`,
        details: [
          {
            path: 'blueprintVersion',
            issue: `unsupported blueprint version ${version}`,
          },
        ],
      }),
    );
  }

  return ok(version);
}

/**
 * One step up the version ladder: version N in, version N+1 out.
 *
 * Takes and returns a loose object, not a `Blueprint` — the input is by
 * definition an *older* shape, and typing it as the current one would be a lie
 * that makes every migration start with a cast.
 */
export type BlueprintMigration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations by the version they upgrade *from*.
 *
 * Empty, because version 1 is the only format that has ever existed. That is
 * the honest state and it is not a stub: `migrateBlueprint` walks this map, so
 * introducing version 2 means writing `{ 1: (doc) => ... }` here and changing
 * `BLUEPRINT_VERSION` — no new machinery, and no format left unreadable.
 */
export const BLUEPRINT_MIGRATIONS: Readonly<Record<number, BlueprintMigration>> = {};

/**
 * Walk an older blueprint up to the current format.
 *
 * Thin on purpose: the walk lives in `migrateToVersion` so it can be tested
 * against a target above 1. With one format in existence, a walk aimed at
 * `BLUEPRINT_VERSION` never takes a step — so every test of *this* function
 * would pass against an implementation that did nothing at all, including one
 * that silently skips a step the day version 2 ships. The alternative to the
 * seam is machinery whose first real execution is on a user's file.
 */
export function migrateBlueprint(
  raw: unknown,
  migrations: Readonly<Record<number, BlueprintMigration>> = BLUEPRINT_MIGRATIONS,
): Result<Record<string, unknown>, AppError> {
  return migrateToVersion(raw, migrations, BLUEPRINT_VERSION);
}

/**
 * The version walk, with its target given explicitly.
 *
 * Package-internal — deliberately absent from `index.ts`. A caller outside this
 * package that could choose the target could produce a document claiming a
 * format this build cannot read; inside, it is how the walk is tested before
 * there is a second format to walk to.
 */
export function migrateToVersion(
  raw: unknown,
  migrations: Readonly<Record<number, BlueprintMigration>>,
  target: number,
): Result<Record<string, unknown>, AppError> {
  const gate = blueprintVersionOf(raw);
  if (!gate.ok) {
    return err(gate.error);
  }

  let document = { ...(raw as Record<string, unknown>) };
  let version = gate.value;

  while (version < target) {
    const step = migrations[version];
    if (step === undefined) {
      return err(
        new AppError({
          code: 'VALIDATION_ERROR',
          message: `Blueprint format ${version} can no longer be read by this build`,
          details: [
            {
              path: 'blueprintVersion',
              issue: `no migration from blueprint version ${version}`,
            },
          ],
        }),
      );
    }
    document = step(document);
    const next = document['blueprintVersion'];
    // A migration that does not advance the version would loop forever. Trusting
    // the step to be correct is how that becomes a hung request rather than an
    // error, so the walk checks rather than assumes.
    if (typeof next !== 'number' || next <= version) {
      return err(
        new AppError({
          code: 'INTERNAL_ERROR',
          message: 'Blueprint migration did not advance the format version',
          details: [
            {
              path: 'blueprintVersion',
              issue: `migration from ${version} produced ${String(next)}`,
            },
          ],
        }),
      );
    }
    version = next;
  }

  return ok(document);
}

/* ────────────────────────── validation ────────────────────────── */

/** `entities[1].fields[2].type` — §14's error path, built as we descend. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Refuse a forbidden key wherever it appears in the envelope.
 *
 * One pass over the named envelope objects rather than a recursive walk of the
 * whole document, because a recursive walk would reach `entities` — where these
 * names are the user's own schema and must be left alone.
 */
function checkEnvelopeKeys(document: Record<string, unknown>, errors: ErrorDetail[]): void {
  const scopes: [string, unknown][] = [
    ['', document],
    ['project', document['project']],
    ['metadata', document['metadata']],
    ['authentication', document['authentication']],
    ['generationConfig', document['generationConfig']],
  ];

  for (const [prefix, scope] of scopes) {
    if (!isPlainObject(scope)) {
      continue;
    }
    for (const key of Object.keys(scope)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (ENVELOPE_KEY_EXEMPTIONS.has(path)) {
        continue;
      }
      if (BLUEPRINT_FORBIDDEN_KEYS.includes(key)) {
        errors.push({
          path,
          issue: 'a blueprint must not contain credentials; remove this key and re-export',
        });
      } else if (BLUEPRINT_ASSIGNED_KEYS.includes(key)) {
        errors.push({
          path,
          issue: `${key} is assigned when the project is created and must not appear in a blueprint`,
        });
      }
    }
  }
}

/**
 * Validate a *current-format* blueprint's envelope.
 *
 * The definition itself is not validated here — `normalizeBlueprint` hands it
 * to `validateIPS`, which already checks every field type, name, depth,
 * relationship target and authentication rule. Re-checking any of that here
 * would be a second, drifting copy of the project contract, which is what §14
 * means by "do not create a second error system".
 *
 * Every problem found is reported, not just the first: someone repairing a
 * hand-edited file should see the whole list.
 */
export function validateBlueprint(raw: unknown): Result<Blueprint, AppError> {
  const gate = blueprintVersionOf(raw);
  if (!gate.ok) {
    return err(gate.error);
  }
  const document = raw as Record<string, unknown>;
  const errors: ErrorDetail[] = [];

  if (gate.value !== BLUEPRINT_VERSION) {
    errors.push({
      path: 'blueprintVersion',
      issue: `expected blueprint version ${BLUEPRINT_VERSION}; migrate before validating`,
    });
  }

  if (typeof document['schemaVersion'] !== 'string' || document['schemaVersion'].trim() === '') {
    errors.push({ path: 'schemaVersion', issue: 'schemaVersion must be a non-empty string' });
  }

  const metadata = document['metadata'];
  if (!isPlainObject(metadata)) {
    errors.push({ path: 'metadata', issue: 'metadata is required' });
  } else {
    const sourceVersion = metadata['sourceVersion'];
    if (
      typeof sourceVersion !== 'number' ||
      !Number.isInteger(sourceVersion) ||
      sourceVersion < 1
    ) {
      errors.push({
        path: 'metadata.sourceVersion',
        issue: 'sourceVersion must be a positive integer',
      });
    }
    if (metadata['exportedAt'] !== undefined && typeof metadata['exportedAt'] !== 'string') {
      errors.push({
        path: 'metadata.exportedAt',
        issue: 'exportedAt must be a string when present',
      });
    }
  }

  const project = document['project'];
  if (!isPlainObject(project)) {
    errors.push({ path: 'project', issue: 'project is required' });
  } else {
    if (typeof project['name'] !== 'string' || project['name'].trim() === '') {
      errors.push({ path: 'project.name', issue: 'name must be a non-empty string' });
    }
    if (
      project['description'] !== undefined &&
      project['description'] !== null &&
      typeof project['description'] !== 'string'
    ) {
      errors.push({
        path: 'project.description',
        issue: 'description must be a string or null when present',
      });
    }
    if (!PROJECT_KINDS.includes(project['kind'] as ProjectKind)) {
      errors.push({
        path: 'project.kind',
        issue: `kind must be one of ${PROJECT_KINDS.join(', ')}`,
      });
    }
  }

  if (!Array.isArray(document['entities'])) {
    errors.push({ path: 'entities', issue: 'entities must be an array' });
  }

  if (!isPlainObject(document['generationConfig'])) {
    errors.push({ path: 'generationConfig', issue: 'generationConfig is required' });
  }

  if (
    document['authentication'] !== undefined &&
    document['authentication'] !== null &&
    !isPlainObject(document['authentication'])
  ) {
    errors.push({
      path: 'authentication',
      issue: 'authentication must be an object when present',
    });
  }

  checkEnvelopeKeys(document, errors);

  if (errors.length > 0) {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Blueprint validation failed',
        details: errors,
      }),
    );
  }

  return ok(document as unknown as Blueprint);
}

/* ────────────────────────── normalization ────────────────────────── */

export interface NormalizeBlueprintOptions {
  /**
   * The new project's id. Required, and never read from the blueprint (§15).
   *
   * Passing it in is what makes "an import creates a new project" structural
   * rather than a convention: there is no code path here that could reuse the
   * source project's id.
   */
  projectId: string;
}

/**
 * A validated blueprint, as a canonical IPS ready to store.
 *
 * Built field by field — see the module's whitelist invariant — and in the same
 * order `parseBuilderPayload` uses for the wizard, so an imported project is
 * the same shape of document as a created one:
 *
 * 1. assemble the authored definition, with the caller's `projectId` and v1
 * 2. `validateIPS` — the canonical rules, on what the author actually wrote
 * 3. `materializeRelations` — derive identity and foreign-key fields
 *
 * Validating *before* materializing matters, and concretely: materialization
 * inserts the identity field at index 0, so validating afterwards shifts every
 * reported path by one. A bad type on the author's first field comes back as
 * `entities[0].fields[1].type`, naming a different field than the one they
 * wrote — and §14 asks these paths to identify the problem. Swapping the two
 * lines is caught by "refuses a malformed field type, with the canonical path".
 *
 * `validateIPS` runs here rather than in the caller, collapsing the last two
 * steps of §13's flow. Deliberately: a `normalizeBlueprint` that could return
 * an unvalidated IPS is one a caller can forget to check, and "never partially
 * import an invalid blueprint" is easier to keep true when the unvalidated
 * value never exists.
 */
export function normalizeBlueprint(
  blueprint: Blueprint,
  options: NormalizeBlueprintOptions,
): Result<InternalProjectSchema, AppError> {
  const authentication = blueprint.authentication;

  const ips: InternalProjectSchema = {
    projectId: options.projectId,
    // A new project, so v1 — never the source's version, which travels as
    // `metadata['sourceVersion']` and stays informational (§15).
    version: 1,
    kind: blueprint.project['kind'],
    entities: blueprint.entities,
    generationConfig: blueprint.generationConfig,
    /*
     * Omitted when absent or `NONE`, matching `parseBuilderPayload`.
     *
     * Not cosmetic: "never configured" and "configured off" have to stay the
     * same document, or a blueprint round trip would show an
     * `AUTH_MODE_CHANGED` in the imported project's first diff — a change
     * nobody made.
     */
    ...(authentication !== undefined && authentication !== null && authentication.mode !== 'NONE'
      ? { authentication }
      : {}),
  };

  const validated = validateIPS(ips);
  if (!validated.ok) {
    return err(validated.error);
  }

  /*
   * Duplicate stable ids, checked here because a blueprint is the only way one
   * can arrive.
   *
   * `validateIPS` does not look at ids — nothing it validates can produce a
   * duplicate, since `ensureSchemaIds` mints from random bytes. A hand-edited
   * or hostile blueprint can, and the damage is silent and later: the diff
   * engine pairs entities by id, so two entities sharing one would compare
   * against each other and a version comparison would report changes that never
   * happened. Rejecting on import is the only cheap place to catch it.
   */
  const duplicates = duplicateSchemaIds(ips);
  if (duplicates.length > 0) {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Blueprint contains duplicate stable ids',
        details: duplicates.map((id) => ({
          path: 'entities',
          issue: `stable id '${id}' is used more than once`,
        })),
      }),
    );
  }

  return ok(materializeRelations(validated.value));
}

/**
 * The whole §13 import pipeline, as one call.
 *
 * Offered alongside the three functions §13 names because the *order* is part
 * of the safety property, and an importer that composes them itself can get it
 * wrong in ways that are hard to see — validating before migrating, or
 * normalizing something that was never validated. Nothing is created by this;
 * it either returns a ready definition or the structured reason it cannot.
 */
export function readBlueprint(
  raw: unknown,
  options: NormalizeBlueprintOptions,
): Result<{ ips: InternalProjectSchema; blueprint: Blueprint }, AppError> {
  const migrated = migrateBlueprint(raw);
  if (!migrated.ok) {
    return err(migrated.error);
  }

  const validated = validateBlueprint(migrated.value);
  if (!validated.ok) {
    return err(validated.error);
  }

  const normalized = normalizeBlueprint(validated.value, options);
  if (!normalized.ok) {
    return err(normalized.error);
  }

  return ok({ ips: normalized.value, blueprint: validated.value });
}

/* ────────────────────────── export ────────────────────────── */

export interface BuildBlueprintOptions {
  /** The project's name — stored on `Project`, not in the definition. */
  name: string;
  description?: string | null;
  /**
   * An ISO instant, when the caller wants the file stamped.
   *
   * Off by default so two exports of an unchanged project are byte-identical,
   * which is what makes the round-trip guarantee (§25) checkable and lets a
   * user diff two blueprints without every line moving. A clock also has no
   * place in this package: nothing here reads one.
   */
  exportedAt?: string;
}

/**
 * Strip credential-named keys out of one envelope object.
 *
 * The mirror of `checkEnvelopeKeys`, against the same list. Import *refuses* a
 * blueprint carrying a credential; export *omits* one — because §12 requires
 * the produced file to be safe to share, and a stored definition can be
 * polluted: `parseBuilderPayload` passes the wizard payload's `authentication`
 * block through, and `validateAuth` does not reject keys it does not know. So a
 * project can hold a stray `signingKey` in its auth block, and emitting it
 * would produce a file that is both alarming and un-importable.
 *
 * A blacklist rather than a whitelist of `AuthConfig`'s fields, deliberately: a
 * whitelist would silently drop a legitimate new configuration field until
 * someone updated it, which is a worse failure than passing an odd key through.
 * The exemptions are honoured here too — `authentication.refreshToken` is a
 * flag, and dropping it would turn the `/refresh` endpoint off on import.
 */
function withoutForbiddenKeys<T extends object>(scope: T, prefix: string): T {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (BLUEPRINT_FORBIDDEN_KEYS.includes(key) && !ENVELOPE_KEY_EXEMPTIONS.has(path)) {
      continue;
    }
    clean[key] = value;
  }
  return clean as T;
}

/**
 * A definition, as a portable blueprint (§11, §12, §17).
 *
 * Assembled field by field — the same whitelist discipline the import side
 * uses, applied outward. That is what keeps the "do not include" half of §12
 * true without a list of things to remember to delete: `publicId`, `slug`,
 * `projectId`, `hosted`, `status` and every other project or runtime field are
 * absent because nothing here asks for them, not because something stripped
 * them. The IPS handed in routinely *does* carry `publicId` and `slug` — the
 * documentation route overlays them deliberately — and they still cannot reach
 * the file.
 *
 * Secrets need no handling at all: a project's signing key lives in
 * `MockAuthSecret`, a separate collection this package cannot read and whose
 * own docstring names this exporter as the reason it is separate.
 *
 * The definition itself (`entities`, `generationConfig`) is carried across
 * whole rather than rebuilt field by field. It is the canonical contract, it is
 * recursive, and it grows — a deep whitelist here would silently drop new field
 * properties from every export until someone remembered to add them, and losing
 * real data is worse than carrying an unrecognised key that `validateIPS`
 * ignores on the way back in.
 *
 * Deep-copied, so the returned blueprint does not alias the caller's document:
 * an exporter whose output changes when the caller later edits the project is a
 * bug waiting for a concurrent request.
 */
export function buildBlueprint(
  ips: InternalProjectSchema,
  options: BuildBlueprintOptions,
): Blueprint {
  const copy = JSON.parse(JSON.stringify(ips)) as InternalProjectSchema;
  const authentication = copy.authentication;

  return {
    blueprintVersion: BLUEPRINT_VERSION,
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    metadata: {
      // Where it came from, informational — the imported project starts at v1.
      sourceVersion: copy.version,
      ...(options.exportedAt === undefined ? {} : { exportedAt: options.exportedAt }),
    },
    project: {
      name: options.name,
      description: options.description ?? null,
      kind: copy.kind ?? 'project',
    },
    entities: copy.entities ?? [],
    /*
     * Omitted when absent or `NONE`, matching both `normalizeBlueprint` and
     * `parseBuilderPayload`. Symmetry is the point: a project with no auth
     * block exports a blueprint with no auth block, which imports back to a
     * project with no auth block — so a round trip shows no change.
     */
    ...(authentication !== undefined && authentication !== null && authentication.mode !== 'NONE'
      ? { authentication: withoutForbiddenKeys(authentication, 'authentication') }
      : {}),
    generationConfig: withoutForbiddenKeys(copy.generationConfig, 'generationConfig'),
  };
}

/**
 * The filename a downloaded blueprint lands as.
 *
 * §17 writes it as `project.blueprint.json`. The suffix is the part that
 * matters — it is what makes the file recognisable and what an importer can
 * filter on — while a fixed stem means a user exporting three projects into one
 * folder gets `project.blueprint.json`, `project.blueprint (1).json` and
 * `project.blueprint (2).json`, which is an unusable set. So the stem is the
 * project's own slug, falling back to the literal §17 wrote.
 */
export function blueprintFilename(project: { slug?: string | null }): string {
  /*
   * Lowercased, which matters for more than tidiness.
   *
   * `web-must-not-import-server` forbids the web app importing this package, so
   * the rule is mirrored in `apps/web/src/lib/notes-document.ts` — the client
   * downloads from the parsed body, which it pretty-prints, so it needs the
   * name itself rather than the `content-disposition` header. Two copies can
   * drift, and the way they would have drifted is exactly here: the web's
   * slugger lowercases and this one did not, so `My Shop` produced two
   * different filenames. Both now lowercase; the same literals are pinned in
   * both test suites.
   */
  const stem = (project.slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${stem === '' ? 'project' : stem}.blueprint.json`;
}

/**
 * The documentation model (Phase 4 §9).
 *
 *     IPS → Documentation Model → Markdown Renderer → Technical Notes
 *                              ↘ AI Renderer       → AI context
 *
 * A structured projection of the canonical definition, with every derivation
 * already done: resolved authentication, derived endpoints, completed
 * relations. Both renderers read this and neither computes anything, which is
 * what stops the human document and the AI document describing different
 * projects.
 *
 * ## It is a projection, never a source
 *
 * §1: Technical Notes are derived *from* the canonical definition and must
 * never become configuration. Nothing here is stored, nothing round-trips back
 * into a project, and this module has no way to write anything — it takes an
 * `InternalProjectSchema` and returns a value.
 *
 * ## Determinism (§8)
 *
 * Same definition in, same model out. Two decisions carry that:
 *
 * **Document order, not id order.** §8 asks for sorting by stable id, and the
 * goal behind it — a stable rendering — is already met: `entities`, `fields` and
 * `relations` are stored arrays and their order is part of the definition.
 * Sorting by `ent_`/`fld_` ids would reorder a schema by random strings, so the
 * document would read in an arbitrary sequence that changes the moment anything
 * is re-created. Author order is both stable *and* the order the author meant.
 *
 * **Endpoints sort by `(path, method)`, in code-unit order.** They have no
 * stable id — endpoint identity in this codebase is `(method, path)` and Phase
 * 2 deliberately left `ep_` unminted — so that pair is the only deterministic
 * key available. Path first, so every operation on a resource is adjacent:
 * `GET /post`, `POST /post`, `GET /post/{id}` read as one group rather than
 * being split across the document by verb.
 *
 * Compared with `<`/`>` rather than `localeCompare`, which resolves against the
 * **host's** default locale. ICU gives punctuation variable weight and locales
 * disagree about letters, so `localeCompare` would order `/post-archive`
 * against `/post/{id}`, or two non-ASCII entity names, differently on different
 * machines — §8 determinism broken by the environment rather than by the
 * definition. Code-unit order is total, locale-free and identical everywhere.
 *
 * Nothing here reads a clock, a database, or `Math.random`.
 */

import { entitySlug, projectEndpoints, type EndpointRow, type HttpMethod } from '@instantmockapi/shared';
import {
  authEnabled,
  completeRelation,
  entityAuth,
  entityIdentity,
  entityQueryFields,
  entityRelations,
  isCollectionRelation,
  projectAuth,
  queryFeatures,
  type AuthConfig,
  type Entity,
  type EntityQueryFields,
  type Field,
  type GenerationConfig,
  type InternalProjectSchema,
  type QueryFeatures,
  type Relation,
} from '@instantmockapi/ips';

/* ────────────────────────── the model ────────────────────────── */

/**
 * Facts that are true of the project rather than of its definition.
 *
 * Separated because §8 requires deterministic output and §2 asks for status and
 * published version — which move without the definition changing. Keeping them
 * in their own object means a renderer can put them under a heading that says
 * so, and a determinism test can compare everything else.
 *
 * All optional: a caller documenting a historical snapshot has a definition and
 * no live status, and inventing one would be the misleading kind of complete.
 */
export interface RuntimeFacts {
  status?: string;
  publishedVersion?: number | null;
  pendingRegeneration?: boolean;
  hostedUrl?: string | null;
  /** Where the definition came from: a stored version, or the live project. */
  source?: 'version' | 'project' | 'draft';
  /** Rendered in its own section, never inside the canonical body (§8). */
  generatedAt?: string;
}

export interface NotesProject {
  name: string;
  description: string | null;
  /** `project` | `single` | `auth`. */
  kind: string;
  version: number;
  /** Public routing id, when one has been minted. Not a secret. */
  publicId: string | null;
  slug: string | null;
}

export interface NotesValidation {
  /** `email`, `min=18`, `regex=^a.*$` — one entry per rule, already formatted. */
  rules: string[];
}

export interface NotesField {
  /** Stable `fld_…` id, when the definition carries one (§3). */
  id: string | null;
  name: string;
  /** Dotted path for a nested field: `address.city`. */
  path: string;
  type: string;
  required: boolean;
  /** The raw stored value, faithfully. Read `hasDefault` before rendering it. */
  default: unknown;
  /**
   * Whether the field genuinely has a default.
   *
   * **`null` counts as no default**, which is this codebase's convention rather
   * than a guess: `zod.ts` and `yup.ts` both emit `.default(...)` only when the
   * value is neither `undefined` nor `null`, and the parsers write `null` as
   * their unset value. So a document that printed `default=null` would claim a
   * default the generated validators do not produce — and would print it on
   * almost every field, since `materializeRelations` and the JSON adapter set
   * `null` throughout.
   *
   * The generated validators are the authority here: they are what actually
   * applies a default at runtime.
   */
  hasDefault: boolean;
  validation: NotesValidation;
  /** `identity`, `foreign key`, `unique`, `read-only`, `searchable`. */
  traits: string[];
  /** Nested object/array members, already flattened into their own entries. */
  children: NotesField[];
}

export interface NotesRelation {
  id: string | null;
  name: string;
  kind: string;
  /** Entity this relation is declared on. */
  source: string;
  target: string;
  localField: string;
  foreignField: string;
  /** `one-to-many` | `many-to-one` | `one-to-one` | `many-to-many`. */
  cardinality: string;
  onDelete: string;
  /** Whether expanding it yields an array. */
  collection: boolean;
}

export interface NotesEntity {
  id: string | null;
  name: string;
  description: string | null;
  /** URL segment the hosted API routes it at. */
  path: string;
  /** **Resolved** (§5): what a caller actually has to do, not the raw override. */
  requiresAuth: boolean;
  identity: { field: string; style: string };
  fields: NotesField[];
  relations: NotesRelation[];
  query: EntityQueryFields;
}

export interface NotesEndpoint {
  method: HttpMethod;
  path: string;
  summary: string;
  /** Absent for the discovery document. */
  entity: string | null;
  /** Resolved, per §5 — `ALL_PUBLIC`/`ALL_PROTECTED`/`COMBINATION` all applied. */
  requiresAuth: boolean;
  /** True for the five Auth API endpoints. */
  isAuthApi: boolean;
  /** `{id}` style parameters this path declares. */
  pathParams: string[];
  /** Query parameters the runtime will accept here. */
  queryParams: string[];
  /** Entity name whose schema is the request body, or null. */
  requestEntity: string | null;
  responseShape: 'entity' | 'collection' | 'none' | 'index' | 'session' | 'user';
}

/**
 * Authentication as documented (§6) — configuration only.
 *
 * There is no field here for a signing key, a token or a hash, and that is the
 * point: §6 and §26 forbid documenting credentials, and the strongest form of
 * that is a model with nowhere to put one. `MockAuthSecret` is never read by
 * this module.
 */
export interface NotesAuth {
  enabled: boolean;
  mode: string;
  endpoints: { method: HttpMethod; path: string; requiresToken: boolean }[];
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
  cookieAuth: boolean;
  userFields: { name: string; type: string; required: boolean }[];
  /** Entity names a caller needs a token for. */
  protectedEntities: string[];
}

export interface NotesGeneration {
  validators: string[];
  types: string[];
  methods: string[];
  mockRecords: number;
  features: QueryFeatures;
}

export interface DocumentationModel {
  project: NotesProject;
  runtime: RuntimeFacts;
  auth: NotesAuth;
  entities: NotesEntity[];
  /** Every relation in the project, flattened, in entity-then-declaration order. */
  relations: NotesRelation[];
  endpoints: NotesEndpoint[];
  generation: NotesGeneration;
}

/* ────────────────────────── derivation ────────────────────────── */

/** `email`, `min=18`, `enum=a|b` — stable order, so two runs match. */
function describeValidation(field: Field): NotesValidation {
  const rules: string[] = [];
  const validation = field.validation ?? {};

  // Fixed order, not `Object.keys`: key order on a `Mixed` document is whatever
  // Mongo returned, which §8 forbids depending on.
  if (validation.email === true) rules.push('email');
  if (validation.url === true) rules.push('url');
  if (validation.uuid === true) rules.push('uuid');
  if (typeof validation.min === 'number') rules.push(`min=${validation.min}`);
  if (typeof validation.max === 'number') rules.push(`max=${validation.max}`);
  if (typeof validation.length === 'number') rules.push(`length=${validation.length}`);
  if (typeof validation.regex === 'string' && validation.regex !== '') {
    rules.push(`regex=${validation.regex}`);
  }
  if (Array.isArray(validation.enum) && validation.enum.length > 0) {
    rules.push(`enum=${validation.enum.join('|')}`);
  }
  const arrayLength = validation.arrayLength;
  if (arrayLength !== null && arrayLength !== undefined) {
    if (typeof arrayLength.min === 'number') rules.push(`items>=${arrayLength.min}`);
    if (typeof arrayLength.max === 'number') rules.push(`items<=${arrayLength.max}`);
  }

  return { rules };
}

/**
 * Field traits worth a reader's attention, in a fixed order.
 *
 * `meta` is an open record (`[key: string]: unknown`), so only the documented
 * keys are read — an unknown key is not turned into prose, because there is no
 * way to know it is safe to print.
 */
function describeTraits(field: Field): string[] {
  const meta = field.meta ?? {};
  const traits: string[] = [];
  if (meta.identity === true) traits.push('identity');
  if (meta.reference === true) {
    traits.push(typeof meta.relation === 'string' ? `foreign key → ${meta.relation}` : 'foreign key');
  }
  if (meta.unique === true) traits.push('unique');
  if (meta.readOnly === true) traits.push('read-only');
  if (meta.searchable === true) traits.push('searchable');
  return traits;
}

function toNotesField(field: Field, prefix: string): NotesField {
  const path = prefix === '' ? field.name : `${prefix}.${field.name}`;
  return {
    id: field.id ?? null,
    name: field.name,
    path,
    type: field.type,
    required: field.required,
    default: field.default,
    hasDefault: field.default !== undefined && field.default !== null,
    validation: describeValidation(field),
    traits: describeTraits(field),
    children: (field.children ?? []).map((child) => toNotesField(child, path)),
  };
}

/**
 * A relation's cardinality, in the words §4 asks for.
 *
 * The `default` branch is unreachable for a well-typed definition — `kind` is a
 * closed union of four values — but a `Version.ipsSnapshot` is a `Mixed`
 * document and an imported blueprint (§14) is arbitrary JSON, so an unknown or
 * absent kind is reachable in practice. Echoing it keeps the document honest
 * about what it read; the string guard is what stops it printing the literal
 * `undefined`, which reads as a rendering bug rather than as missing data.
 */
function describeCardinality(relation: Relation): string {
  switch (relation.kind) {
    case 'hasMany':
      return 'one-to-many';
    case 'belongsTo':
      return 'many-to-one';
    case 'hasOne':
      return 'one-to-one';
    case 'manyToMany':
      return 'many-to-many';
    default:
      return typeof relation.kind === 'string' && relation.kind !== ''
        ? relation.kind
        : 'unspecified';
  }
}

function toNotesRelation(entity: Entity, relation: Relation, entities: readonly Entity[]): NotesRelation | null {
  const target = entities.find((candidate) => candidate.name === relation.target);
  if (target === undefined) {
    // `validateIPS` rejects a relation whose target is not declared, so this is
    // only reachable on a hand-authored document. Dropped rather than rendered
    // as a dangling arrow a reader would try to follow.
    return null;
  }
  const completed = completeRelation(entity, relation, target);
  return {
    id: relation.id ?? null,
    name: completed.name,
    kind: completed.kind,
    source: entity.name,
    target: completed.target,
    localField: completed.localField,
    foreignField: completed.foreignField,
    cardinality: describeCardinality(completed),
    onDelete: completed.onDelete ?? 'restrict',
    collection: isCollectionRelation(completed),
  };
}

/** `/student/{id}` → `['id']`. */
function pathParamsOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

/**
 * Query parameters the runtime accepts for a list endpoint.
 *
 * Derived from the same `entityQueryFields` the runtime validates against and
 * limited to the enabled features, so the document never lists a parameter that
 * would answer 400.
 */
function queryParamsOf(
  row: EndpointRow,
  entity: Entity | undefined,
  features: QueryFeatures,
): string[] {
  if (row.target !== 'collection' || row.method !== 'GET' || entity === undefined) {
    return [];
  }
  const fields = entityQueryFields(entity);
  const params = ['page', 'limit'];
  if (features.search && fields.searchable.length > 0) params.push('search');
  if (features.sort && fields.sortable.length > 0) params.push('sort');
  if (features.include && fields.includable.length > 0) params.push('include');
  if (features.filter) params.push(...fields.filterable);
  return params;
}

function responseShapeOf(row: EndpointRow): NotesEndpoint['responseShape'] {
  if (row.target === 'index') return 'index';
  if (row.method === 'DELETE') return 'none';
  return row.target === 'collection' && row.method === 'GET' ? 'collection' : 'entity';
}

/** The Auth API's endpoints, as `NotesEndpoint` rows (§6). */
function authEndpoints(auth: AuthConfig): NotesEndpoint[] {
  const rows: NotesEndpoint[] = [];
  const entry = (
    method: HttpMethod,
    name: string,
    requiresAuth: boolean,
    responseShape: NotesEndpoint['responseShape'],
    summary: string,
  ): NotesEndpoint => ({
    method,
    path: `/${name}`,
    summary,
    entity: null,
    requiresAuth,
    isAuthApi: true,
    pathParams: [],
    queryParams: [],
    requestEntity: null,
    responseShape,
  });

  if (auth.signup) {
    rows.push(entry('POST', 'signUp', false, 'session', 'Create an account and sign in'));
  }
  if (auth.signin) {
    rows.push(entry('POST', 'signIn', false, 'session', 'Sign in'));
  }
  if (auth.refreshToken) {
    rows.push(entry('POST', 'refresh', false, 'session', 'Exchange a refresh token'));
  }
  rows.push(entry('GET', 'me', true, 'user', 'The signed-in user'));
  rows.push(entry('POST', 'logout', false, 'none', 'Revoke the refresh session'));
  return rows;
}

/**
 * Code-unit comparison — the locale-free half of §8.
 *
 * `String.prototype.localeCompare` would read the host's default locale, so the
 * same definition could render in a different order on a developer's machine
 * and on the server. See the module docstring.
 */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Deterministic endpoint order: path, then method. See the module docstring. */
function byPathThenMethod(a: NotesEndpoint, b: NotesEndpoint): number {
  return a.path === b.path ? byCodeUnit(a.method, b.method) : byCodeUnit(a.path, b.path);
}

/**
 * A stored value, serialised for a document.
 *
 * Object keys are sorted. `JSON.stringify` emits them in insertion order, which
 * for a value read out of a `Mixed` Mongo field is whatever the driver returned
 * — the one thing this module's determinism rule names as off-limits. Sorting
 * costs nothing and makes the claim true for every input rather than for the
 * scalar defaults that happen to be common.
 */
export function stringifyDefault(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }
    const source = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(byCodeUnit)) {
      sorted[key] = source[key];
    }
    return sorted;
  });
}

/**
 * Everything the model needs that is not in the definition.
 *
 * `name` and `description` live on the `Project` document rather than in the
 * IPS, and `runtime` is the mutable half §8 keeps out of the canonical body.
 */
export interface DocumentationMeta {
  name: string;
  description?: string | null;
  runtime?: RuntimeFacts;
}

/**
 * Build the documentation model from a canonical definition.
 *
 * `ips` must already be normalised — `normaliseSnapshot` overlays the version's
 * `configSnapshot` over the copy embedded in `ipsSnapshot` and materializes
 * relations. Passing a raw `Version.ipsSnapshot` would document a config that
 * version never had, which is Phase 2's bug 10 wearing a different hat.
 */
export function buildDocumentationModel(
  ips: InternalProjectSchema,
  meta: DocumentationMeta = { name: '' },
): DocumentationModel {
  const config: GenerationConfig = ips.generationConfig;
  const features = queryFeatures(config);
  const auth = projectAuth(ips);
  const enabled = authEnabled(auth);
  const entities = ips.entities ?? [];

  const notesEntities: NotesEntity[] = entities.map((entity) => {
    const identity = entityIdentity(entity);
    return {
      id: entity.id ?? null,
      name: entity.name,
      description: entity.description ?? null,
      path: entitySlug(entity),
      // Resolved, per §5. `entityAuth` is the only permitted reader of the
      // mode-plus-override pair; reading `entity.authentication` here would
      // document every entity as public on an ALL_PROTECTED project.
      requiresAuth: enabled && entityAuth(auth, entity) === 'PROTECTED',
      identity: { field: identity.field, style: identity.style },
      fields: (entity.fields ?? []).map((field) => toNotesField(field, '')),
      relations: entityRelations(entity)
        .map((relation) => toNotesRelation(entity, relation, entities))
        .filter((relation): relation is NotesRelation => relation !== null),
      query: entityQueryFields(entity),
    };
  });

  const entityRows = projectEndpoints(entities, config.methods).map((row): NotesEndpoint => {
    const entity = entities.find((candidate) => candidate.name === row.entity);
    const documented = notesEntities.find((candidate) => candidate.name === row.entity);
    return {
      method: row.method,
      path: row.path === '' ? '/' : row.path,
      summary: row.summary,
      entity: row.entity ?? null,
      // The discovery document is never protected: it advertises the routes and
      // carries no record data.
      requiresAuth: row.target === 'index' ? false : (documented?.requiresAuth ?? false),
      isAuthApi: false,
      pathParams: pathParamsOf(row.path),
      queryParams: queryParamsOf(row, entity, features),
      requestEntity:
        row.method === 'POST' || row.method === 'PUT' || row.method === 'PATCH'
          ? (row.entity ?? null)
          : null,
      responseShape: responseShapeOf(row),
    };
  });

  return {
    project: {
      name: meta.name,
      description: meta.description ?? null,
      kind: ips.kind ?? 'project',
      version: ips.version,
      publicId: ips.publicId ?? null,
      slug: ips.slug ?? null,
    },
    runtime: meta.runtime ?? {},
    auth: {
      enabled,
      mode: auth.mode,
      endpoints: enabled
        ? authEndpoints(auth).map((row) => ({
            method: row.method,
            path: row.path,
            requiresToken: row.requiresAuth,
          }))
        : [],
      accessTokenExpiresIn: auth.accessTokenExpiresIn,
      refreshTokenExpiresIn: auth.refreshTokenExpiresIn,
      cookieAuth: auth.cookieAuth,
      userFields: auth.userFields.map((field) => ({ ...field })),
      protectedEntities: notesEntities
        .filter((entity) => entity.requiresAuth)
        .map((entity) => entity.name),
    },
    entities: notesEntities,
    relations: notesEntities.flatMap((entity) => entity.relations),
    // Auth endpoints first, then the entity surface — a caller has to use the
    // first group before the protected half of the second works.
    endpoints: [
      ...(enabled ? authEndpoints(auth) : []),
      ...entityRows.sort(byPathThenMethod),
    ],
    generation: {
      validators: [...config.validators],
      types: [...config.types],
      methods: [...config.methods],
      mockRecords: config.mockRecords,
      features,
    },
  };
}

/** Every field of an entity, nested ones included, in document order. */
export function flattenFields(fields: readonly NotesField[]): NotesField[] {
  return fields.flatMap((field) => [field, ...flattenFields(field.children)]);
}

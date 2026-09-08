/**
 * Hosting config generator (Worker F, doc 09 §4).
 *
 * Produces the routing/config the mock runtime interprets: entities, selected
 * methods, the IPS validation model (the safe-interpreter input — the runtime
 * never executes generated code, doc 13 §4), identity and relation descriptors,
 * and a seed-store reference. Worker D's seed records are loaded into
 * `mockStores` by the orchestrator; this config only points at them.
 *
 * Everything the runtime needs to answer a request is precomputed here, so the
 * runtime performs lookups rather than derivations (doc 19 §Phase A/B).
 */

import { entitySlug, HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
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
  type Entity,
  type Field,
  type InternalProjectSchema,
  type EntityQueryFields,
  type QueryFeatures,
  type Relation,
  type RelationKind,
} from '@instantmockapi/ips';

export interface HostedFieldRule {
  name: string;
  type: Field['type'];
  required: boolean;
  default: unknown;
  validation: Field['validation'];
  /**
   * Field metadata. Previously dropped here, which is why `meta.identity` and
   * `meta.reference` never reached the runtime — it needs them to treat identity
   * as server-assigned and to locate foreign keys without re-deriving them.
   */
  meta: Field['meta'];
  children: HostedFieldRule[];
}

/** Record identity — what `GET /{entity}/{id}` routes on. */
export interface HostedIdentityRule {
  field: string;
  style: 'int' | 'uuid';
}

/** A relation the runtime can resolve without consulting the IPS. */
export interface HostedRelationRule {
  /** `?include=` key and the property an expansion is written to. */
  name: string;
  kind: RelationKind;
  /** Target entity name. */
  target: string;
  /** Target's hosted path, precomputed so the runtime needs no name→path index. */
  targetPath: string;
  /** Field on this entity. */
  localField: string;
  /** Field on the target. */
  foreignField: string;
  /** Expands to an array rather than a single record. */
  collection: boolean;
  onDelete: Relation['onDelete'];
}

export interface HostedEntityConfig {
  name: string;
  /** URL segment: GET /p/{projectId}/{path} */
  path: string;
  methods: HttpMethod[];
  fields: HostedFieldRule[];
  identity: HostedIdentityRule;
  relations: HostedRelationRule[];
  /**
   * Which fields the query layer accepts, precomputed per entity.
   *
   * The runtime validates a request against these lists rather than re-walking
   * the field tree, and the same derivation feeds the OpenAPI parameter list —
   * so a 400 from the runtime and the documented parameters can never disagree.
   * Absent on configs generated before the query layer.
   */
  query?: EntityQueryFields;
  /**
   * Whether this entity's endpoints require a token (Phase 3 §13, §14).
   *
   * **Already resolved.** The project's mode has been applied, so the runtime
   * reads a yes/no answer and is never given the inputs it could re-derive a
   * wrong one from. That is the Stage 1 invariant crossing the artifact
   * boundary — the resolution happens once, here, at generation time.
   *
   * Named `requiresAuth` rather than `authentication` deliberately, and the
   * difference is not cosmetic: the IPS field of that name is the *authored
   * override*, meaningful only in `COMBINATION` mode, and reading it as though
   * it were the answer is precisely the mistake `auth-invariants.test.ts`
   * exists to catch. Two names for two concepts keeps that guard able to tell
   * them apart, and keeps a reader from assuming this is a copy of the input.
   *
   * A boolean rather than `'PUBLIC' | 'PROTECTED'` for the same reason: it is
   * an answer, not a restatement of the vocabulary the question was asked in.
   *
   * Absent on configs generated before Phase 3, read as public.
   */
  requiresAuth?: boolean;
  seedStore: { collection: 'mockStores'; entity: string };
}

export interface HostingConfig {
  projectId: string;
  version: number;
  /**
   * Enabled query capabilities, copied from the generation config.
   *
   * Project-wide rather than per-entity because that is the granularity the
   * wizard offers. Absent on configs generated before the query layer, which
   * `resolveQueryFeatures` reads as all-off.
   */
  features?: QueryFeatures;
  /**
   * The generated API's authentication (Phase 3 §15).
   *
   * Absent on every config generated before Phase 3, which the runtime reads as
   * mode `NONE` — §26's compatibility rule, and the reason this is optional
   * rather than defaulted here.
   *
   * **No signing key.** §23 forbids putting a secret in a Blueprint, and this
   * config *is* part of the export bundle. The key lives in its own collection
   * (`MockAuthSecret`) and is fetched at request time; a config that carried it
   * would hand out the ability to mint tokens for the project to anyone who
   * downloaded the ZIP.
   */
  auth?: HostedAuthConfig;
  entities: HostedEntityConfig[];
}

/**
 * The runtime's view of a project's authentication.
 *
 * Deliberately **not** `AuthConfig`. The runtime never needs the mode: what it
 * needs is which endpoints exist and, per entity, whether a token is required —
 * both already resolved. Copying the mode across would invite the runtime to
 * re-derive `entityAuth`, which is the one thing the Stage 1 invariant forbids.
 */
export interface HostedAuthConfig {
  /** Which of the five auth endpoints to serve. */
  signup: boolean;
  signin: boolean;
  refresh: boolean;
  /** HttpOnly cookie mode (§9). Changes CORS and the signin response shape. */
  cookieAuth: boolean;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
  /** Extra signup fields beyond email and password (§5). */
  userFields: { name: string; type: 'string' | 'number' | 'boolean'; required: boolean }[];
}

function fieldRule(field: Field): HostedFieldRule {
  return {
    name: field.name,
    type: field.type,
    required: field.required,
    default: field.default,
    validation: field.validation,
    meta: field.meta ?? {},
    children: field.children.map(fieldRule),
  };
}

// The route the runtime matches on. Shared with the docs generators so a
// hosted URL and its documentation can never drift apart.
function entityPath(name: string): string {
  return entitySlug({ name });
}

/**
 * Relations are completed defensively rather than assumed materialized, so a
 * hand-authored pack is hostable without a round trip through the API.
 */
function relationRules(entity: Entity, entities: readonly Entity[]): HostedRelationRule[] {
  const rules: HostedRelationRule[] = [];
  for (const relation of entityRelations(entity)) {
    const target = entities.find((candidate) => candidate.name === relation.target);
    if (!target) {
      continue; // the IPS validator rejects these; drop rather than emit a dead route
    }
    const completed = completeRelation(entity, relation, target);
    rules.push({
      name: completed.name,
      kind: completed.kind,
      target: completed.target,
      targetPath: entityPath(completed.target),
      localField: completed.localField,
      foreignField: completed.foreignField,
      collection: isCollectionRelation(completed),
      onDelete: completed.onDelete,
    });
  }
  return rules;
}

export function generateHostingConfig(ips: InternalProjectSchema): Record<string, string> {
  const chosen = new Set(ips.generationConfig.methods);
  const methods = HTTP_METHODS.filter((m) => chosen.has(m));
  const entities = ips.entities ?? [];

  // Resolved ONCE, here. The runtime is handed the answer rather than the
  // inputs, so it cannot re-derive protection from `entity.authentication` and
  // get `ALL_PROTECTED` wrong. See `packages/ips/src/auth-invariants.test.ts`.
  const auth = projectAuth(ips);

  const config: HostingConfig = {
    projectId: ips.projectId,
    version: ips.version,
    features: queryFeatures(ips.generationConfig),
    ...(authEnabled(auth)
      ? {
          auth: {
            signup: auth.signup,
            signin: auth.signin,
            refresh: auth.refreshToken,
            cookieAuth: auth.cookieAuth,
            accessTokenExpiresIn: auth.accessTokenExpiresIn,
            refreshTokenExpiresIn: auth.refreshTokenExpiresIn,
            userFields: auth.userFields.map((field) => ({ ...field })),
          },
        }
      : {}),
    entities: entities.map((entity) => {
      const path = entityPath(entity.name);
      return {
        name: entity.name,
        path,
        methods: [...methods],
        fields: entity.fields.map(fieldRule),
        identity: entityIdentity(entity),
        relations: relationRules(entity, entities),
        query: entityQueryFields(entity),
        // Emitted only when there is an Auth API to enforce it. On a project
        // with authentication off, every entity stays absent and the config is
        // byte-identical to a pre-Phase-3 one — which is what §26 asks for.
        ...(authEnabled(auth) ? { requiresAuth: entityAuth(auth, entity) === 'PROTECTED' } : {}),
        seedStore: { collection: 'mockStores', entity: path },
      };
    }),
  };

  return { 'hosting.config.json': JSON.stringify(config, null, 2) };
}

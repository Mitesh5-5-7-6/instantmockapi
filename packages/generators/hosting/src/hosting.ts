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

import { HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
import {
  completeRelation,
  entityIdentity,
  entityRelations,
  isCollectionRelation,
  type Entity,
  type Field,
  type InternalProjectSchema,
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
  seedStore: { collection: 'mockStores'; entity: string };
}

export interface HostingConfig {
  projectId: string;
  version: number;
  entities: HostedEntityConfig[];
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

function entityPath(name: string): string {
  return name.toLowerCase();
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

  const config: HostingConfig = {
    projectId: ips.projectId,
    version: ips.version,
    entities: entities.map((entity) => {
      const path = entityPath(entity.name);
      return {
        name: entity.name,
        path,
        methods: [...methods],
        fields: entity.fields.map(fieldRule),
        identity: entityIdentity(entity),
        relations: relationRules(entity, entities),
        seedStore: { collection: 'mockStores', entity: path },
      };
    }),
  };

  return { 'hosting.config.json': JSON.stringify(config, null, 2) };
}

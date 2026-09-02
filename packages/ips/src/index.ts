// @instantmockapi/ips — Internal Project Schema types, validation, versioning

export {
  type FieldType,
  type ValidationRules,
  type FieldMeta,
  type Field,
  type Entity,
  type EntityIdentity,
  type Relation,
  type RelationKind,
  type GenerationConfig,
  type InternalProjectSchema,
} from './types.js';

export { validateIPS } from './validator.js';

export {
  QUERY_FEATURES,
  type QueryFeature,
  type QueryFeatures,
  type FilterOperator,
  type EntityQueryFields,
  RESERVED_QUERY_KEYS,
  FILTER_OPERATORS,
  NO_QUERY_FEATURES,
  ALL_QUERY_FEATURES,
  resolveQueryFeatures,
  queryFeatures,
  hasQueryFeatures,
  enabledQueryFeatures,
  queryableFields,
  searchableFields,
  includableRelations,
  entityQueryFields,
} from './query.js';

export {
  DEFAULT_IDENTITY,
  type RelationInput,
  completeRelation,
  entityIdentity,
  entityRelations,
  identityFieldType,
  isCollectionRelation,
  isOwningRelation,
  materializeRelations,
  topologicalEntityOrder,
} from './relations.js';

export {
  deepClone,
  bumpIPSVersion,
  createIPSSnapshot,
  restoreIPSFromSnapshot,
} from './versioning.js';

/**
 * Stable internal identity for schema elements (Phase 1).
 *
 * `ensureSchemaIds` is the idempotent backfill: every project generated before
 * Phase 1 has no ids, and this mints the missing ones without ever replacing one
 * that exists.
 */
export {
  ID_PREFIX,
  SCHEMA_ID_PATTERN,
  collectSchemaIds,
  duplicateSchemaIds,
  ensureSchemaIds,
  isSchemaId,
  newSchemaId,
  type BackfillResult,
  type SchemaElementKind,
} from './ids.js';

/**
 * Change detection (Phase 1): what differs between the active definition and a
 * draft, with the severity a user needs before committing and the read/write
 * aspect that keeps impact analysis precise.
 */
export {
  CHANGE_KINDS,
  diffSchemas,
  highestRisk,
  needsAttention,
  summariseChanges,
  CHANGE_RISKS,
  type ChangeAspect,
  type ChangeKind,
  type ChangeRisk,
  type SchemaChange,
} from './changes.js';

// ---------------------------------------------------------------------------
// Dependency graph and impact analysis (Phase 1)
// ---------------------------------------------------------------------------
export {
  buildDependencyGraph,
  edgeFacet,
  endpointNode,
  entityNode,
  fieldNode,
  generatorNode,
  relationNode,
  PROJECT_NODE,
  type DependencyEdge,
  type DependencyGraph,
  type EdgeAspect,
  type GraphNode,
  type NodeKind,
} from './graph.js';

export {
  analyseDraftImpact,
  analyseImpact,
  type AffectedEndpoint,
  type ImpactReason,
  type ImpactReport,
  type UnaffectedEndpoint,
  type UnattributedChange,
} from './impact.js';

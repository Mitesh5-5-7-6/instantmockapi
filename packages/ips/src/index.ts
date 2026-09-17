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
  type AuthConfig,
  type AuthMode,
  type AuthUserField,
  type EntityAuth,
  UNKNOWN_FIELD_POLICIES,
  DEFAULT_UNKNOWN_FIELDS,
  type UnknownFieldPolicy,
} from './types.js';

export {
  resolveUnknownFields,
  unknownFieldPolicy,
  unknownFieldsDirection,
  describeUnknownFields,
} from './unknown-fields.js';

export {
  AUTH_ENDPOINT_NAMES,
  AUTH_MODES,
  RESERVED_ENTITY_NAMES,
  type AuthEndpointName,
  DEFAULT_ACCESS_TOKEN_TTL,
  DEFAULT_REFRESH_TOKEN_TTL,
  NO_AUTH,
  authEnabled,
  entityAuth,
  projectAuth,
  protectedEntities,
  stampEntityAuth,
} from './auth.js';

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
  type RenameSource,
  detectEntityRenames,
  reconcileEntityRenames,
  reconcileRenamesInSchema,
} from './renames.js';

/*
 * `versioning.ts` was deleted rather than kept for a future caller.
 *
 * `createIPSSnapshot` / `restoreIPSFromSnapshot` / `bumpIPSVersion` had no
 * callers anywhere outside this re-export, and `createIPSSnapshot` produced
 * `{ entities }` only — a *different* shape from the full `InternalProjectSchema`
 * that `generation-service.ts` actually writes to `Version.ipsSnapshot`. So the
 * first person to reach for the obviously-named helper would have written a
 * snapshot missing `projectId`, `version`, `publicId` and `slug`, and the bug
 * would surface much later as an unreadable version. A trap, not an asset.
 */

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
  validationDirection,
  CHANGE_RISKS,
  type ChangeAspect,
  type ChangeKind,
  type ChangeRisk,
  type DiffOptions,
  type MatchBasis,
  type MatchMode,
  type SchemaChange,
  type ValidationDirection,
  type ValidationKey,
} from './changes.js';

/**
 * The three-value impact axis (Phase 2 §12): do existing callers break — yes,
 * maybe, or no.
 *
 * A **projection** of a change, never stored beside `risk`. The comparison view
 * renders this axis; the commit dialog renders `risk`; neither renders both in
 * one row, because eight of the kinds legitimately disagree.
 */
export {
  CHANGE_IMPACTS,
  CHANGE_TYPES,
  classifyChangeType,
  classifyImpact,
  summariseChangeTypes,
  summariseImpact,
  worstImpact,
  type ChangeImpact,
  type ChangeType,
} from './classification.js';

/**
 * Comparing two version snapshots (Phase 2 §24), including snapshots written
 * before stable ids existed — which need a name fallback, and need to say so.
 */
export {
  compareSnapshots,
  diffSnapshots,
  normaliseSnapshot,
  type CompareOptions,
  type MatchingReport,
  type SchemaDiff,
  type SchemaSnapshot,
} from './compare.js';

/**
 * The change hierarchy (Phase 2 §37): entity → fields / relations / endpoints.
 *
 * Computed here rather than in the web app so the commit dialog and the
 * comparison page render the same tree — `ARCHITECTURE.md`: clients render this
 * chain, they do not recompute it.
 */
export {
  groupChanges,
  treeImpact,
  type ChangeGroupCounts,
  type ChangeTree,
  type EndpointRef,
  type EntityGroup,
  type FieldGroup,
  type GroupStatus,
  type GroupedChange,
  type ProjectGroup,
  type RelationGroup,
} from './grouping.js';

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
  IMPACTED_ARTIFACTS,
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

export {
  BLUEPRINT_FORBIDDEN_KEYS,
  blueprintFilename,
  buildBlueprint,
  BLUEPRINT_MIGRATIONS,
  BLUEPRINT_SCHEMA_VERSION,
  BLUEPRINT_VERSION,
  blueprintVersionOf,
  migrateBlueprint,
  normalizeBlueprint,
  readBlueprint,
  validateBlueprint,
  type Blueprint,
  type BlueprintMetadata,
  type BlueprintMigration,
  type BlueprintProject,
  type BuildBlueprintOptions,
  type NormalizeBlueprintOptions,
} from './blueprint.js';

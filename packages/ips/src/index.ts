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

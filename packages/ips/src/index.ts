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

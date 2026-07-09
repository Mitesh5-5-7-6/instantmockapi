// @instantmockapi/ips — Internal Project Schema types, validation, versioning

export {
  type FieldType,
  type ValidationRules,
  type FieldMeta,
  type Field,
  type Entity,
  type GenerationConfig,
  type InternalProjectSchema,
} from './types.js';

export { validateIPS } from './validator.js';

export {
  deepClone,
  bumpIPSVersion,
  createIPSSnapshot,
  restoreIPSFromSnapshot,
} from './versioning.js';

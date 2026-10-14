import { AppError, HTTP_METHODS, type ErrorDetail, type ProjectKind } from '@instantmockapi/shared';
import {
  validateIPS,
  type Entity,
  type Field,
  type FieldMeta,
  type GenerationConfig,
  type Relation,
} from '@instantmockapi/ips';
import { parseBuilderPayload } from '@instantmockapi/parsers';
import { cleanProse, isRecord } from './sanitize.js';

/** Exactly what the builder input source carries. */
export interface BuilderShape {
  entities: Entity[];
  generationConfig: GenerationConfig;
}

/**
 * Meta keys a proposal may set. The rest (`reference`, `readOnly`, `relation`)
 * are written by `materializeRelations`; accepting them from the model would let
 * it claim a field is a foreign key that no relation backs.
 */
const PROPOSABLE_META = ['unique', 'identity', 'searchable'] as const;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Coerce model output (or a client-edited blueprint) into the builder shape.
 *
 * **Shape only — never semantics.** Unknown types, dangling relation targets,
 * bad names all pass through untouched so IPS reports them with exact paths;
 * those paths are what the repair call and the UI show. Rejecting here would
 * make this a second validator that could disagree with the real one.
 *
 * What it does remove is everything the platform owns: ids, authentication,
 * and generation settings other than methods and record count.
 */
export function toBuilderShape(raw: unknown, defaults: GenerationConfig): BuilderShape {
  const source = isRecord(raw) ? raw : {};
  return {
    entities: asArray(source['entities']).map(toEntity),
    generationConfig: toGenerationConfig(source['generationConfig'], defaults),
  };
}

function toEntity(raw: unknown): Entity {
  const entity = isRecord(raw) ? raw : {};
  const description = cleanProse(entity['description']);
  return {
    name: asString(entity['name']),
    fields: asArray(entity['fields']).map(toField),
    relations: asArray(entity['relations']).map(toRelation),
    ...(isRecord(entity['identity'])
      ? { identity: entity['identity'] as unknown as NonNullable<Entity['identity']> }
      : {}),
    ...(description ? { description } : {}),
  };
}

function toField(raw: unknown): Field {
  const field = isRecord(raw) ? raw : {};
  const rawMeta = isRecord(field['meta']) ? field['meta'] : {};
  const meta: FieldMeta = {};
  for (const key of PROPOSABLE_META) {
    if (rawMeta[key] === true) {
      meta[key] = true;
    }
  }
  return {
    name: asString(field['name']),
    type: asString(field['type']) as Field['type'],
    required: field['required'] !== false,
    default: field['default'] === undefined ? null : field['default'],
    children: asArray(field['children']).map(toField),
    validation: isRecord(field['validation']) ? (field['validation'] as Field['validation']) : {},
    meta,
  };
}

function toRelation(raw: unknown): Relation {
  const relation = isRecord(raw) ? raw : {};
  return {
    name: asString(relation['name']),
    kind: asString(relation['kind']) as Relation['kind'],
    target: asString(relation['target']),
    // Empty means "derive it": completeRelation fills localField/foreignField
    // from the target's identity, so the model need not spell foreign keys out.
    localField: asString(relation['localField']),
    foreignField: asString(relation['foreignField']),
    required: relation['required'] === true,
    onDelete: (asString(relation['onDelete']) || 'restrict') as Relation['onDelete'],
  };
}

function toGenerationConfig(raw: unknown, defaults: GenerationConfig): GenerationConfig {
  const config = isRecord(raw) ? raw : {};
  const known = HTTP_METHODS as readonly string[];
  const methods = asArray(config['methods']).filter(
    (method): method is GenerationConfig['methods'][number] =>
      typeof method === 'string' && known.includes(method),
  );
  const mockRecords = config['mockRecords'];
  return {
    ...defaults,
    methods: methods.length > 0 ? [...new Set(methods)] : defaults.methods,
    mockRecords:
      typeof mockRecords === 'number' && Number.isInteger(mockRecords)
        ? mockRecords
        : defaults.mockRecords,
  };
}

/**
 * Run the real builder pipeline and return its complaints, or `[]`.
 *
 * Same adapter `parseInputSource('builder')` uses, plus the depth-capped second
 * pass it runs, so "valid here" means "commit will accept it".
 */
export function validateShape(
  shape: BuilderShape,
  kind: ProjectKind | undefined,
  maxDepth: number,
): ErrorDetail[] {
  const parsed = parseBuilderPayload(
    'proposal',
    'proposal',
    shape.entities,
    shape.generationConfig,
    undefined,
    kind,
  );
  if (!parsed.ok) {
    return detailsOf(parsed.error);
  }
  const checked = validateIPS(parsed.value, maxDepth);
  return checked.ok ? [] : detailsOf(checked.error);
}

function detailsOf(error: Error): ErrorDetail[] {
  if (error instanceof AppError && error.details.length > 0) {
    return [...error.details];
  }
  return [{ path: '', issue: error.message }];
}

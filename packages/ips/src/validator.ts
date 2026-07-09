/**
 * IPS Meta-Schema Validator and Nesting Depth Cap checker.
 *
 * Enforces structural and semantic constraints on the Internal Project Schema (IPS)
 * before any generation job starts (doc 04 §F3, doc 13 §3).
 */

import { AppError, type ErrorDetail, type Result, ok, err } from '@instantmockapi/shared';
import type { InternalProjectSchema, Entity, Field, FieldType } from './types.js';

const VALID_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  'string',
  'number',
  'decimal',
  'integer',
  'boolean',
  'date',
  'email',
  'url',
  'uuid',
  'enum',
  'object',
  'array',
]);

const NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface ValidationCtx {
  errors: ErrorDetail[];
  maxDepth: number;
}

/**
 * Validate an InternalProjectSchema (IPS) against structural rules and depth constraints.
 *
 * Returns a Result with void on success, or an AppError containing details of all
 * failures on validation/depth limits (doc 04 §F3, doc 13 §3).
 */
export function validateIPS(
  ips: unknown,
  maxDepth = 10,
): Result<InternalProjectSchema, AppError> {
  const ctx: ValidationCtx = {
    errors: [],
    maxDepth,
  };

  if (!ips || typeof ips !== 'object') {
    return err(
      new AppError({
        code: 'VALIDATION_ERROR',
        message: 'IPS must be a non-null object',
      }),
    );
  }

  const schema = ips as Partial<InternalProjectSchema>;

  // 1. Validate projectId
  if (typeof schema.projectId !== 'string' || !schema.projectId.trim()) {
    ctx.errors.push({ path: 'projectId', issue: 'projectId must be a non-empty string' });
  }

  // 2. Validate version
  if (
    typeof schema.version !== 'number' ||
    !Number.isInteger(schema.version) ||
    schema.version < 1
  ) {
    ctx.errors.push({ path: 'version', issue: 'version must be a positive integer >= 1' });
  }

  // 3. Validate generationConfig
  if (!schema.generationConfig || typeof schema.generationConfig !== 'object') {
    ctx.errors.push({ path: 'generationConfig', issue: 'generationConfig is required' });
  } else {
    const config = schema.generationConfig;
    if (!Array.isArray(config.validators)) {
      ctx.errors.push({
        path: 'generationConfig.validators',
        issue: 'validators must be an array of strings',
      });
    }
    if (!Array.isArray(config.types)) {
      ctx.errors.push({
        path: 'generationConfig.types',
        issue: 'types must be an array of strings',
      });
    }
    if (!Array.isArray(config.methods)) {
      ctx.errors.push({
        path: 'generationConfig.methods',
        issue: 'methods must be an array of HTTP methods',
      });
    }
    if (
      typeof config.mockRecords !== 'number' ||
      !Number.isInteger(config.mockRecords) ||
      config.mockRecords < 0
    ) {
      ctx.errors.push({
        path: 'generationConfig.mockRecords',
        issue: 'mockRecords must be a non-negative integer',
      });
    }
  }

  // 4. Validate entities
  if (!Array.isArray(schema.entities)) {
    ctx.errors.push({ path: 'entities', issue: 'entities must be an array' });
  } else {
    const entities = schema.entities;
    if (entities.length === 0) {
      ctx.errors.push({ path: 'entities', issue: 'projects must have at least one entity' });
    }

    const entityNames = new Set<string>();

    entities.forEach((entity, entityIdx) => {
      const path = `entities[${entityIdx}]`;
      if (!entity || typeof entity !== 'object') {
        ctx.errors.push({ path, issue: 'entity must be a non-null object' });
        return;
      }

      const ent = entity as Partial<Entity>;

      // Entity name checks
      if (typeof ent.name !== 'string' || !ent.name.trim()) {
        ctx.errors.push({ path: `${path}.name`, issue: 'Entity name is required' });
      } else if (!NAME_REGEX.test(ent.name)) {
        ctx.errors.push({
          path: `${path}.name`,
          issue: `Entity name '${ent.name}' is invalid (must start with letter, alphanumeric/underscore only)`,
        });
      } else {
        if (entityNames.has(ent.name)) {
          ctx.errors.push({
            path: `${path}.name`,
            issue: `Duplicate entity name '${ent.name}'`,
          });
        }
        entityNames.add(ent.name);
      }

      // Fields checks
      if (!Array.isArray(ent.fields)) {
        ctx.errors.push({ path: `${path}.fields`, issue: 'fields must be an array' });
      } else {
        const fields = ent.fields;
        if (fields.length === 0) {
          ctx.errors.push({
            path: `${path}.fields`,
            issue: `Entity '${ent.name ?? entityIdx}' must have at least one field`,
          });
        }

        const fieldNames = new Set<string>();
        fields.forEach((field, fieldIdx) => {
          validateField(
            field,
            `${path}.fields[${fieldIdx}]`,
            1, // starts at depth 1
            fieldNames,
            ctx,
          );
        });
      }
    });
  }

  if (ctx.errors.length > 0) {
    const isDepthError = ctx.errors.some((e) => e.issue.includes('exceeds max depth'));
    return err(
      new AppError({
        code: isDepthError ? 'DEPTH_LIMIT_EXCEEDED' : 'VALIDATION_ERROR',
        message: 'IPS validation failed',
        details: ctx.errors,
      }),
    );
  }

  return ok(schema as InternalProjectSchema);
}

function validateField(
  field: unknown,
  path: string,
  depth: number,
  siblingNames: Set<string>,
  ctx: ValidationCtx,
): void {
  if (!field || typeof field !== 'object') {
    ctx.errors.push({ path, issue: 'field must be an object' });
    return;
  }

  const f = field as Partial<Field>;

  // Check depth cap limit (doc 04 §F3, doc 13 §3)
  if (depth > ctx.maxDepth) {
    ctx.errors.push({
      path,
      issue: `Nesting depth of ${depth} exceeds max depth of ${ctx.maxDepth}`,
    });
    return;
  }

  // Field name check
  if (typeof f.name !== 'string' || !f.name.trim()) {
    ctx.errors.push({ path: `${path}.name`, issue: 'Field name is required' });
  } else if (!FIELD_NAME_REGEX.test(f.name)) {
    ctx.errors.push({
      path: `${path}.name`,
      issue: `Field name '${f.name}' must be alphanumeric starting with letter/underscore`,
    });
  } else {
    if (siblingNames.has(f.name)) {
      ctx.errors.push({ path: `${path}.name`, issue: `Duplicate field name '${f.name}'` });
    }
    siblingNames.add(f.name);
  }

  // Field type check
  if (typeof f.type !== 'string' || !VALID_FIELD_TYPES.has(f.type as FieldType)) {
    ctx.errors.push({
      path: `${path}.type`,
      issue: `Field type must be one of: ${Array.from(VALID_FIELD_TYPES).join(', ')}`,
    });
  }

  // required check
  if (typeof f.required !== 'boolean') {
    ctx.errors.push({ path: `${path}.required`, issue: 'required must be a boolean' });
  }

  // children check
  const hasChildren = Array.isArray(f.children);
  if (f.type === 'object' || f.type === 'array') {
    if (!hasChildren) {
      ctx.errors.push({
        path: `${path}.children`,
        issue: `Fields of type '${f.type}' must have a children array`,
      });
    } else {
      const childNames = new Set<string>();
      f.children!.forEach((child, childIdx) => {
        validateField(child, `${path}.children[${childIdx}]`, depth + 1, childNames, ctx);
      });
    }
  } else {
    if (hasChildren && f.children!.length > 0) {
      ctx.errors.push({
        path: `${path}.children`,
        issue: `Primitive field type '${f.type}' cannot have children`,
      });
    }
  }

  // validation configuration checks
  if (f.validation && typeof f.validation === 'object') {
    const rules = f.validation;
    if (rules.min !== undefined && typeof rules.min !== 'number') {
      ctx.errors.push({ path: `${path}.validation.min`, issue: 'min must be a number' });
    }
    if (rules.max !== undefined && typeof rules.max !== 'number') {
      ctx.errors.push({ path: `${path}.validation.max`, issue: 'max must be a number' });
    }
    if (rules.length !== undefined && typeof rules.length !== 'number') {
      ctx.errors.push({ path: `${path}.validation.length`, issue: 'length must be a number' });
    }
    if (rules.regex !== undefined && rules.regex !== null && typeof rules.regex !== 'string') {
      ctx.errors.push({ path: `${path}.validation.regex`, issue: 'regex must be a string or null' });
    }
    if (rules.enum !== undefined && rules.enum !== null && !Array.isArray(rules.enum)) {
      ctx.errors.push({ path: `${path}.validation.enum`, issue: 'enum must be an array of strings or null' });
    }
    if (rules.email !== undefined && typeof rules.email !== 'boolean') {
      ctx.errors.push({ path: `${path}.validation.email`, issue: 'email must be a boolean' });
    }
    if (rules.url !== undefined && typeof rules.url !== 'boolean') {
      ctx.errors.push({ path: `${path}.validation.url`, issue: 'url must be a boolean' });
    }
    if (rules.uuid !== undefined && typeof rules.uuid !== 'boolean') {
      ctx.errors.push({ path: `${path}.validation.uuid`, issue: 'uuid must be a boolean' });
    }
  }
}

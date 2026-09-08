/**
 * IPS Meta-Schema Validator and Nesting Depth Cap checker.
 *
 * Enforces structural and semantic constraints on the Internal Project Schema (IPS)
 * before any generation job starts (doc 04 §F3, doc 13 §3).
 */

import { AppError, type ErrorDetail, type Result, ok, err } from '@instantmockapi/shared';
import type {
  InternalProjectSchema,
  Entity,
  Field,
  FieldType,
  Relation,
  RelationKind,
} from './types.js';
import { AUTH_MODES, RESERVED_ENTITY_NAMES } from './auth.js';
import {
  completeRelation,
  entityIdentity,
  entityRelations,
  isOwningRelation,
} from './relations.js';

const VALID_RELATION_KINDS: ReadonlySet<RelationKind> = new Set<RelationKind>([
  'belongsTo',
  'hasOne',
  'hasMany',
  'manyToMany',
]);

const VALID_ON_DELETE: ReadonlySet<Relation['onDelete']> = new Set<Relation['onDelete']>([
  'restrict',
  'cascade',
  'setNull',
]);

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
export function validateIPS(ips: unknown, maxDepth = 10): Result<InternalProjectSchema, AppError> {
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

  // 3b. Validate authentication (Phase 3 §15)
  //
  // Absent is valid and means mode NONE — §26's compatibility rule. Present and
  // malformed is an error the author must see: `projectAuth` deliberately
  // tolerates junk so a comparison of two historical versions cannot crash, and
  // this is the counterpart that stops junk being *written* in the first place.
  if (schema.authentication !== undefined && schema.authentication !== null) {
    validateAuth(schema.authentication, ctx);
  }

  /*
   * 3c. Entity names the Auth API occupies (Phase 3 §4).
   *
   * The five auth endpoints live at the root of the hosted API — `/signUp`,
   * `/signIn`, `/refresh`, `/me`, `/logout` — because that is the shape §4
   * specifies and it reaches the generated OpenAPI and Postman collection. They
   * therefore share a namespace with entity paths, and `entitySlug` lowercases,
   * so an entity called `Me` would claim `/me`.
   *
   * Reserved **only when authentication is enabled**, which is what keeps §26:
   * a project that already has a `Me` entity keeps working untouched, and
   * turning authentication on gives its author a validation error naming the
   * entity to rename — rather than a route that silently resolves to the wrong
   * handler.
   */
  if (schema.authentication !== undefined && schema.authentication !== null) {
    const mode = (schema.authentication as { mode?: unknown }).mode;
    if (typeof mode === 'string' && mode !== 'NONE' && Array.isArray(schema.entities)) {
      schema.entities.forEach((entity, index) => {
        const name = (entity as Partial<Entity> | null)?.name;
        if (typeof name === 'string' && RESERVED_ENTITY_NAMES.has(name.toLowerCase())) {
          ctx.errors.push({
            path: `entities[${index}].name`,
            issue: `'${name}' collides with the Auth API endpoint /${name.toLowerCase()} — rename the entity or disable authentication`,
          });
        }
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

      // Identity checks — relations point at it, so it must be well-formed
      if (ent.identity !== undefined) {
        validateIdentity(ent.identity, `${path}.identity`, ctx);
      }

      /*
       * Entity protection (Phase 3 §3).
       *
       * The value only, not whether it belongs here: a stale stamp left by a
       * previous stint in COMBINATION mode is harmless, because `entityAuth`
       * ignores the field outside that mode. Rejecting its presence would break
       * a PATCH that faithfully round-trips an older document.
       *
       * The value itself does matter. `entityAuth` fails closed on anything it
       * does not recognise, so a lowercase `'public'` silently protects the
       * entity — safe, but not what the author wrote, and they would have no
       * way to find out except by getting a 401.
       */
      if (ent.authentication !== undefined) {
        if (ent.authentication !== 'PUBLIC' && ent.authentication !== 'PROTECTED') {
          ctx.errors.push({
            path: `${path}.authentication`,
            issue: "authentication must be 'PUBLIC' or 'PROTECTED'",
          });
        }
      }
    });

    // Relations are validated once every entity is known, so targets resolve and
    // an inverse side can be checked against the field its owning side implies.
    validateRelations(entities as Entity[], ctx);
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

/** `15m`, `7d`, `900s` — the duration grammar §7 and §8 write their defaults in. */
const DURATION_REGEX = /^[1-9][0-9]*(s|m|h|d)$/;

/** Reserved on the auth user, so a custom field cannot shadow or leak one. */
const RESERVED_USER_FIELDS = new Set([
  'id',
  'email',
  'password',
  'passwordHash',
  'createdAt',
  'updatedAt',
]);

/**
 * Validate the authentication block (Phase 3 §15, §23).
 *
 * The reserved-name check is the security-relevant one. §23 forbids exposing a
 * password hash, and §10 forbids returning one from `/me` — but a custom signup
 * field named `passwordHash` would be written from the request body and echoed
 * back as ordinary user data, defeating both rules without either being
 * violated in code. Rejecting the name is the only place that can be caught.
 */
function validateAuth(authentication: unknown, ctx: ValidationCtx): void {
  if (typeof authentication !== 'object' || Array.isArray(authentication)) {
    ctx.errors.push({ path: 'authentication', issue: 'authentication must be an object' });
    return;
  }
  const value = authentication as Record<string, unknown>;

  if (!(AUTH_MODES as readonly unknown[]).includes(value['mode'])) {
    ctx.errors.push({
      path: 'authentication.mode',
      issue: `mode must be one of ${AUTH_MODES.join(', ')}`,
    });
  }

  for (const flag of ['signup', 'signin', 'refreshToken', 'cookieAuth'] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
      ctx.errors.push({ path: `authentication.${flag}`, issue: `${flag} must be a boolean` });
    }
  }

  for (const key of ['accessTokenExpiresIn', 'refreshTokenExpiresIn'] as const) {
    const ttl = value[key];
    if (ttl !== undefined && (typeof ttl !== 'string' || !DURATION_REGEX.test(ttl))) {
      ctx.errors.push({
        path: `authentication.${key}`,
        issue: `${key} must be a duration such as 15m, 24h or 7d`,
      });
    }
  }

  // A project that requires authentication with no way to obtain a token is a
  // locked door with no key: every endpoint 401s and nothing can ever sign in.
  // Rejecting it here beats generating an API nobody can call.
  if (value['mode'] !== 'NONE' && value['signin'] === false) {
    ctx.errors.push({
      path: 'authentication.signin',
      issue:
        'signin cannot be disabled while authentication is enabled — nothing could obtain a token',
    });
  }

  const fields = value['userFields'];
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      ctx.errors.push({ path: 'authentication.userFields', issue: 'userFields must be an array' });
      return;
    }
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      const path = `authentication.userFields[${index}]`;
      if (typeof field !== 'object' || field === null) {
        ctx.errors.push({ path, issue: 'each user field must be an object' });
        return;
      }
      const entry = field as Record<string, unknown>;
      const name = entry['name'];
      if (typeof name !== 'string' || !FIELD_NAME_REGEX.test(name)) {
        ctx.errors.push({ path: `${path}.name`, issue: 'name must be a valid field name' });
        return;
      }
      if (RESERVED_USER_FIELDS.has(name)) {
        ctx.errors.push({
          path: `${path}.name`,
          issue: `'${name}' is reserved on the auth user and cannot be a custom field`,
        });
      }
      if (seen.has(name)) {
        ctx.errors.push({ path: `${path}.name`, issue: `duplicate user field '${name}'` });
      }
      seen.add(name);
      if (entry['type'] !== 'string' && entry['type'] !== 'number' && entry['type'] !== 'boolean') {
        ctx.errors.push({
          path: `${path}.type`,
          issue: "type must be 'string', 'number' or 'boolean'",
        });
      }
      if (entry['required'] !== undefined && typeof entry['required'] !== 'boolean') {
        ctx.errors.push({ path: `${path}.required`, issue: 'required must be a boolean' });
      }
    });
  }
}

function validateIdentity(identity: unknown, path: string, ctx: ValidationCtx): void {
  if (!identity || typeof identity !== 'object') {
    ctx.errors.push({ path, issue: 'identity must be an object' });
    return;
  }
  const value = identity as Partial<Entity['identity']>;
  if (typeof value?.field !== 'string' || !FIELD_NAME_REGEX.test(value.field)) {
    ctx.errors.push({ path: `${path}.field`, issue: 'identity.field must be a valid field name' });
  }
  if (value?.style !== 'int' && value?.style !== 'uuid') {
    ctx.errors.push({ path: `${path}.style`, issue: "identity.style must be 'int' or 'uuid'" });
  }
}

/** Enough of a relation to derive field names from without guessing. */
function isRelationShaped(relation: unknown): relation is Relation {
  const value = relation as Partial<Relation> | null;
  return (
    !!value &&
    typeof value === 'object' &&
    VALID_RELATION_KINDS.has(value.kind as RelationKind) &&
    typeof value.target === 'string' &&
    value.target.length > 0
  );
}

/**
 * The field names an entity carries *after* `materializeRelations` runs: its
 * declared fields, its identity field, and one reference field per owning-side
 * relation.
 *
 * Inverse sides (`hasMany`/`hasOne`) are checked against this projection rather
 * than against `entity.fields`, so a sparsely-authored IPS validates on the write
 * path — a `Classroom hasMany Student` is legal before anything has materialized
 * the `classroomId` its partner `belongsTo` will create.
 */
function projectedFieldNames(entity: Entity, byName: ReadonlyMap<string, Entity>): Set<string> {
  const names = new Set<string>();
  for (const field of Array.isArray(entity.fields) ? entity.fields : []) {
    if (field && typeof field.name === 'string') {
      names.add(field.name);
    }
  }
  names.add(entityIdentity(entity).field);
  for (const relation of entityRelations(entity)) {
    if (isRelationShaped(relation) && isOwningRelation(relation)) {
      names.add(completeRelation(entity, relation, byName.get(relation.target)).localField);
    }
  }
  return names;
}

/**
 * Cross-entity relation checks (doc 19 §Phase A).
 *
 * None of the issues raised here may contain the substring `exceeds max depth`,
 * or `validateIPS`'s error-code heuristic would report them as
 * DEPTH_LIMIT_EXCEEDED instead of VALIDATION_ERROR.
 */
function validateRelations(entities: Entity[], ctx: ValidationCtx): void {
  // Only well-formed entities can be relation targets; malformed ones already
  // reported their own errors. First name wins, mirroring how the duplicate-name
  // check reports the *second* occurrence.
  const byName = new Map<string, Entity>();
  for (const entity of entities) {
    if (entity && typeof entity === 'object' && typeof entity.name === 'string' && entity.name) {
      if (!byName.has(entity.name)) {
        byName.set(entity.name, entity);
      }
    }
  }

  const projected = new Map<string, Set<string>>();
  for (const [name, entity] of byName) {
    projected.set(name, projectedFieldNames(entity, byName));
  }

  entities.forEach((entity, entityIdx) => {
    const path = `entities[${entityIdx}]`;
    if (!entity || typeof entity !== 'object' || entity.relations === undefined) {
      return;
    }
    if (!Array.isArray(entity.relations)) {
      ctx.errors.push({ path: `${path}.relations`, issue: 'relations must be an array' });
      return;
    }

    const declaredFields = new Set<string>();
    for (const field of Array.isArray(entity.fields) ? entity.fields : []) {
      if (field && typeof field.name === 'string') {
        declaredFields.add(field.name);
      }
    }
    const relationNames = new Set<string>();

    entity.relations.forEach((relation, relationIdx) => {
      const rPath = `${path}.relations[${relationIdx}]`;
      if (!relation || typeof relation !== 'object') {
        ctx.errors.push({ path: rPath, issue: 'relation must be a non-null object' });
        return;
      }

      // name — the ?include= key that expansions are written onto
      if (typeof relation.name !== 'string' || !FIELD_NAME_REGEX.test(relation.name)) {
        ctx.errors.push({
          path: `${rPath}.name`,
          issue: 'Relation name must be alphanumeric starting with letter/underscore',
        });
      } else if (relationNames.has(relation.name)) {
        ctx.errors.push({
          path: `${rPath}.name`,
          issue: `Duplicate relation name '${relation.name}'`,
        });
      } else if (declaredFields.has(relation.name)) {
        ctx.errors.push({
          path: `${rPath}.name`,
          issue: `Relation name '${relation.name}' collides with a field of the same name`,
        });
      } else {
        relationNames.add(relation.name);
      }

      const kindValid = VALID_RELATION_KINDS.has(relation.kind);
      if (!kindValid) {
        ctx.errors.push({
          path: `${rPath}.kind`,
          issue: `kind must be one of: ${Array.from(VALID_RELATION_KINDS).join(', ')}`,
        });
      }
      if (relation.onDelete !== undefined && !VALID_ON_DELETE.has(relation.onDelete)) {
        ctx.errors.push({
          path: `${rPath}.onDelete`,
          issue: `onDelete must be one of: ${Array.from(VALID_ON_DELETE).join(', ')}`,
        });
      }
      if (relation.required !== undefined && typeof relation.required !== 'boolean') {
        ctx.errors.push({ path: `${rPath}.required`, issue: 'required must be a boolean' });
      }

      if (typeof relation.target !== 'string' || !relation.target) {
        ctx.errors.push({ path: `${rPath}.target`, issue: 'target entity name is required' });
        return;
      }
      const target = byName.get(relation.target);
      if (!target) {
        ctx.errors.push({
          path: `${rPath}.target`,
          issue: `Relation target '${relation.target}' is not a declared entity`,
        });
        return;
      }
      if (!kindValid) {
        return; // field-name derivation below needs a known kind
      }

      const completed = completeRelation(entity, relation, target);
      const owning = isOwningRelation(completed);

      // A record can't reference itself before it exists, so a mandatory self-FK
      // is unsatisfiable under every insert order.
      if (relation.kind === 'belongsTo' && relation.target === entity.name && completed.required) {
        ctx.errors.push({
          path: `${rPath}.required`,
          issue: `Self-referencing belongsTo '${completed.name}' cannot be required`,
        });
      }

      const targetFields = projected.get(target.name) ?? new Set<string>();
      if (!targetFields.has(completed.foreignField)) {
        ctx.errors.push({
          path: `${rPath}.foreignField`,
          issue: owning
            ? `foreignField '${completed.foreignField}' does not exist on '${target.name}'`
            : `foreignField '${completed.foreignField}' does not exist on '${target.name}' — declare it, or add the matching belongsTo on '${target.name}'`,
        });
      }

      // Owning sides get localField materialized for them; inverse sides read a
      // key that must already exist on this entity.
      if (!owning) {
        const ownFields = projected.get(entity.name) ?? declaredFields;
        if (!ownFields.has(completed.localField)) {
          ctx.errors.push({
            path: `${rPath}.localField`,
            issue: `localField '${completed.localField}' does not exist on '${entity.name}'`,
          });
        }
      }
    });
  });
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
      ctx.errors.push({
        path: `${path}.validation.regex`,
        issue: 'regex must be a string or null',
      });
    }
    if (rules.enum !== undefined && rules.enum !== null && !Array.isArray(rules.enum)) {
      ctx.errors.push({
        path: `${path}.validation.enum`,
        issue: 'enum must be an array of strings or null',
      });
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

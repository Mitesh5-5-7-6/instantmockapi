import { describe, it, expect } from 'vitest';
import { diffSchemas, hasBreakingChanges, summariseChanges, type SchemaChange } from './changes.js';
import { ensureSchemaIds } from './ids.js';
import type { Entity, Field, InternalProjectSchema } from './types.js';

function field(name: string, over: Partial<Field> = {}): Field {
  return {
    name,
    type: 'string',
    required: false,
    default: null,
    children: [],
    validation: {},
    meta: {},
    ...over,
  };
}

function entity(name: string, fields: Field[], over: Partial<Entity> = {}): Entity {
  return { name, fields, ...over };
}

function ips(entities: Entity[], config: Partial<InternalProjectSchema['generationConfig']> = {}) {
  return {
    projectId: 'p1',
    version: 1,
    entities,
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 10,
      ...config,
    },
  } as InternalProjectSchema;
}

/**
 * Fork a draft the way the API will: backfill ids on the active definition, then
 * deep-copy. Both sides then carry the same ids, which is what makes the diff
 * able to tell a rename from a delete-plus-create.
 */
function fork(active: InternalProjectSchema): {
  active: InternalProjectSchema;
  draft: InternalProjectSchema;
} {
  ensureSchemaIds(active);
  return { active, draft: JSON.parse(JSON.stringify(active)) as InternalProjectSchema };
}

const find = (changes: SchemaChange[], kind: string) => changes.filter((c) => c.kind === kind);
const one = (changes: SchemaChange[], kind: string) => {
  const matches = find(changes, kind);
  expect(matches, `expected exactly one ${kind}, got ${matches.length}`).toHaveLength(1);
  return matches[0]!;
};

describe('an untouched draft', () => {
  it('reports no changes at all', () => {
    // The baseline that everything else depends on. A diff that invents changes
    // for an unedited draft makes the whole impact report untrustworthy.
    const { active, draft } = fork(
      ips([entity('User', [field('email'), field('age', { type: 'integer' })])]),
    );
    expect(diffSchemas(active, draft)).toEqual([]);
  });

  it('reports nothing after a JSON round trip', () => {
    // Drafts go through Mongo as `Schema.Types.Mixed`. Empty objects
    // (`validation: {}`, `meta: {}`) must survive, or the diff would report
    // changes the user never made — which is why the model sets minimize: false.
    const { active } = fork(ips([entity('User', [field('email')])]));
    const roundTripped = JSON.parse(JSON.stringify(active)) as InternalProjectSchema;
    expect(diffSchemas(active, roundTripped)).toEqual([]);
  });
});

describe('field type changes', () => {
  /** The spec's worked example: `User.age` string → number. */
  it('is breaking and affects both reads and writes', () => {
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';

    const change = one(diffSchemas(active, draft), 'FIELD_TYPE_CHANGED');
    expect(change).toMatchObject({
      severity: 'breaking',
      // The stored value's shape changes AND previously-valid bodies stop
      // validating, so neither side is safe.
      aspect: 'both',
      before: 'string',
      after: 'integer',
      fieldName: 'age',
      entityName: 'User',
    });
    expect(change.fieldId).toMatch(/^fld_/);
  });
});

describe('field renames', () => {
  /**
   * The reason stable ids exist. By name this is indistinguishable from deleting
   * `firstName` and adding `givenName`; by id it is one field changing.
   */
  it('is one rename, not a removal plus an addition', () => {
    const { active, draft } = fork(ips([entity('User', [field('firstName')])]));
    draft.entities[0]!.fields[0]!.name = 'givenName';

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'FIELD_REMOVED')).toEqual([]);
    expect(find(changes, 'FIELD_ADDED')).toEqual([]);
    expect(one(changes, 'FIELD_RENAMED')).toMatchObject({
      before: 'firstName',
      after: 'givenName',
      severity: 'breaking',
    });
  });
});

describe('requiredness', () => {
  it('is breaking when widened and write-only', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields[0]!.required = true;

    expect(one(diffSchemas(active, draft), 'FIELD_REQUIRED_CHANGED')).toMatchObject({
      severity: 'breaking',
      // A GET response does not care whether the field was mandatory inbound.
      aspect: 'write',
      after: true,
    });
  });

  it('is compatible when relaxed', () => {
    const { active, draft } = fork(ips([entity('User', [field('email', { required: true })])]));
    draft.entities[0]!.fields[0]!.required = false;

    expect(one(diffSchemas(active, draft), 'FIELD_REQUIRED_CHANGED').severity).toBe('compatible');
  });
});

describe('defaults', () => {
  /** The spec's read-vs-write example: a default reaches POST, never GET. */
  it('is compatible and write-only', () => {
    const { active, draft } = fork(ips([entity('User', [field('status', { default: 'active' })])]));
    draft.entities[0]!.fields[0]!.default = 'pending';

    expect(one(diffSchemas(active, draft), 'FIELD_DEFAULT_CHANGED')).toMatchObject({
      severity: 'compatible',
      aspect: 'write',
      before: 'active',
      after: 'pending',
    });
  });
});

describe('enum values', () => {
  /** Spec §18: adding is generally safe, removing is not. */
  it('adding a value is compatible', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('status', { type: 'enum', validation: { enum: ['a', 'b'] } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.enum = ['a', 'b', 'c'];

    const change = one(diffSchemas(active, draft), 'ENUM_VALUES_ADDED');
    expect(change.severity).toBe('compatible');
    expect(change.summary).toContain('c');
  });

  it('removing a value is breaking and affects reads too', () => {
    const { active, draft } = fork(
      ips([
        entity('User', [field('status', { type: 'enum', validation: { enum: ['a', 'b', 'c'] } })]),
      ]),
    );
    draft.entities[0]!.fields[0]!.validation.enum = ['a', 'b'];

    expect(one(diffSchemas(active, draft), 'ENUM_VALUES_REMOVED')).toMatchObject({
      severity: 'breaking',
      // Reads too: stored records may already hold the removed value, so a GET
      // can surface something the schema now disallows.
      aspect: 'both',
    });
  });

  it('reports an add and a remove separately when both happen', () => {
    // Replacing one value is two facts with different severities; collapsing
    // them into one "changed" would hide the breaking half.
    const { active, draft } = fork(
      ips([entity('User', [field('s', { type: 'enum', validation: { enum: ['a', 'b'] } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.enum = ['a', 'c'];

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'ENUM_VALUES_ADDED')).toHaveLength(1);
    expect(find(changes, 'ENUM_VALUES_REMOVED')).toHaveLength(1);
  });

  it('does not also report the enum as a generic validation change', () => {
    // Otherwise every enum edit would appear twice in the user's list.
    const { active, draft } = fork(
      ips([entity('User', [field('s', { type: 'enum', validation: { enum: ['a'] } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.enum = ['a', 'b'];

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'VALIDATION_CHANGED')).toEqual([]);
  });
});

describe('validation rules', () => {
  /** Spec §20's example: minLength 3 → 5. */
  it('reports a tightened rule as breaking and write-only', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('name', { validation: { min: 3 } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.min = 5;

    const change = one(diffSchemas(active, draft), 'VALIDATION_CHANGED');
    expect(change).toMatchObject({ severity: 'breaking', aspect: 'write', before: 3, after: 5 });
    // Rule-level path, so the UI can point at the control that changed.
    expect(change.path).toBe('name.validation.min');
  });

  it('reports a removed rule as compatible', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('name', { validation: { regex: '^a' } })])]),
    );
    delete draft.entities[0]!.fields[0]!.validation.regex;

    expect(one(diffSchemas(active, draft), 'VALIDATION_REMOVED').severity).toBe('compatible');
  });

  /** Spec §19's example: adding email validation to `User.email`. */
  it('reports an added rule as breaking', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields[0]!.validation.email = true;

    expect(one(diffSchemas(active, draft), 'VALIDATION_ADDED')).toMatchObject({
      severity: 'breaking',
      aspect: 'write',
    });
  });

  it('reports one change per rule, not one for the whole block', () => {
    // So the user sees which rule moved rather than "validation changed".
    const { active, draft } = fork(
      ips([entity('User', [field('name', { validation: { min: 1, max: 10 } })])]),
    );
    draft.entities[0]!.fields[0]!.validation = { min: 2, max: 20 };

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'VALIDATION_CHANGED')).toHaveLength(2);
  });
});

describe('nested fields and arrays', () => {
  /** Spec §21: `customer.address.city` must be addressable. */
  it('reports a change three levels deep with a dotted path', () => {
    const { active, draft } = fork(
      ips([entity('Customer', [field('address', { type: 'object', children: [field('city')] })])]),
    );
    draft.entities[0]!.fields[0]!.children[0]!.type = 'enum';

    const change = one(diffSchemas(active, draft), 'FIELD_TYPE_CHANGED');
    expect(change.path).toBe('address.city');
    expect(change.fieldName).toBe('city');
  });

  /** Spec §22: an array's element type lives in children[0]. */
  it('reports a change to an array element type', () => {
    const { active, draft } = fork(
      ips([entity('Post', [field('tags', { type: 'array', children: [field('item')] })])]),
    );
    draft.entities[0]!.fields[0]!.children[0]!.type = 'integer';

    expect(one(diffSchemas(active, draft), 'FIELD_TYPE_CHANGED').path).toBe('tags.item');
  });

  it('omits the path for a top-level field', () => {
    // Redundant with `fieldName` there, and a `path` of "age" reads as if the
    // field were nested.
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';
    expect(one(diffSchemas(active, draft), 'FIELD_TYPE_CHANGED').path).toBeUndefined();
  });
});

describe('adding and removing fields', () => {
  it('treats a new optional field as compatible', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields.push(field('nickname'));

    expect(one(diffSchemas(active, draft), 'FIELD_ADDED').severity).toBe('compatible');
  });

  it('treats a new required field as breaking', () => {
    // Every existing request body that omits it now fails validation.
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields.push(field('phone', { required: true }));

    expect(one(diffSchemas(active, draft), 'FIELD_ADDED').severity).toBe('breaking');
  });

  it('treats a removed field as breaking', () => {
    const { active, draft } = fork(ips([entity('User', [field('email'), field('age')])]));
    draft.entities[0]!.fields.splice(1, 1);

    expect(one(diffSchemas(active, draft), 'FIELD_REMOVED')).toMatchObject({
      severity: 'breaking',
      fieldName: 'age',
    });
  });

  it('does not report an un-backfilled field as removed', () => {
    // An id-less field cannot be paired, and calling it "removed" would be a lie
    // about a schema that simply has not been backfilled.
    const active = ips([entity('User', [field('email')])]);
    const draft = JSON.parse(JSON.stringify(active)) as InternalProjectSchema;
    // Neither side has ids at all.
    expect(find(diffSchemas(active, draft), 'FIELD_REMOVED')).toEqual([]);
  });
});

describe('entities', () => {
  /**
   * The finding that surprised me: stable ids keep the dependency graph intact
   * across a rename, but they do NOT keep the URL intact. The hosted route is
   * `entity.name.toLowerCase()`, so a rename moves every endpoint.
   */
  it('reports a rename as routing-affecting and says the paths move', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.name = 'Customer';

    const change = one(diffSchemas(active, draft), 'ENTITY_RENAMED');
    expect(change).toMatchObject({ severity: 'breaking', aspect: 'routing' });
    expect(change.summary).toMatch(/endpoint paths move/);
    // Not a remove-plus-add.
    expect(find(diffSchemas(active, draft), 'ENTITY_REMOVED')).toEqual([]);
  });

  it('reports an added entity', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    const added = entity('Order', [field('total', { type: 'decimal' })]);
    draft.entities.push(added);
    ensureSchemaIds(draft);

    expect(one(diffSchemas(active, draft), 'ENTITY_ADDED')).toMatchObject({
      severity: 'compatible',
      entityName: 'Order',
    });
  });

  it('reports a removed entity as breaking', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email')]), entity('Order', [field('total')])]),
    );
    draft.entities.splice(1, 1);

    expect(one(diffSchemas(active, draft), 'ENTITY_REMOVED')).toMatchObject({
      severity: 'breaking',
      aspect: 'routing',
      entityName: 'Order',
    });
  });

  it('treats a description edit as cosmetic and reaching nothing', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.description = 'Application user';

    expect(one(diffSchemas(active, draft), 'ENTITY_DESCRIPTION_CHANGED')).toMatchObject({
      severity: 'cosmetic',
      aspect: 'none',
    });
  });

  it('treats an identity change as routing-affecting', () => {
    // Item URLs address by the identity field and relations point at it.
    const { active, draft } = fork(
      ips([entity('User', [field('email')], { identity: { field: 'id', style: 'int' } })]),
    );
    draft.entities[0]!.identity = { field: 'id', style: 'uuid' };

    expect(one(diffSchemas(active, draft), 'ENTITY_IDENTITY_CHANGED')).toMatchObject({
      severity: 'breaking',
      aspect: 'routing',
    });
  });
});

describe('relations', () => {
  const withRelation = () =>
    fork(
      ips([
        entity('Student', [field('name')], {
          relations: [
            {
              name: 'classroom',
              kind: 'belongsTo',
              target: 'Classroom',
              localField: 'classroomId',
              foreignField: 'id',
              required: false,
              onDelete: 'restrict',
            },
          ],
        }),
        entity('Classroom', [field('label')]),
      ]),
    );

  it('reports a removed relation as breaking', () => {
    // `?include=classroom` stops resolving for every existing caller.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations = [];

    expect(one(diffSchemas(active, draft), 'RELATION_REMOVED')).toMatchObject({
      severity: 'breaking',
      relationName: 'classroom',
    });
  });

  it('reports a retarget rather than a remove plus an add', () => {
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.target = 'Teacher';

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'RELATION_REMOVED')).toEqual([]);
    expect(one(changes, 'RELATION_TARGET_CHANGED')).toMatchObject({
      before: 'Classroom',
      after: 'Teacher',
      severity: 'breaking',
    });
  });

  it('reports a cardinality change as breaking', () => {
    // Decides whether an expansion is an object or an array.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.kind = 'hasMany';
    expect(one(diffSchemas(active, draft), 'RELATION_KIND_CHANGED').severity).toBe('breaking');
  });

  it('treats an onDelete change as compatible and write-only', () => {
    // Only observable through DELETE, and only in what happens to the far side.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.onDelete = 'cascade';

    expect(one(diffSchemas(active, draft), 'RELATION_ON_DELETE_CHANGED')).toMatchObject({
      severity: 'compatible',
      aspect: 'write',
    });
  });

  it('reports an added relation as compatible', () => {
    const { active, draft } = withRelation();
    draft.entities[1]!.relations = [
      {
        name: 'students',
        kind: 'hasMany',
        target: 'Student',
        localField: 'id',
        foreignField: 'classroomId',
        required: false,
        onDelete: 'restrict',
      },
    ];
    ensureSchemaIds(draft);

    expect(one(diffSchemas(active, draft), 'RELATION_ADDED').severity).toBe('compatible');
  });
});

describe('generation config', () => {
  it('treats removing a method as breaking and routing-affecting', () => {
    // Endpoints stop existing, which is not a read or a write change — it is the
    // surface itself changing.
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.generationConfig.methods = ['GET', 'POST'];

    const change = one(diffSchemas(active, draft), 'METHODS_CHANGED');
    expect(change).toMatchObject({ severity: 'breaking', aspect: 'routing' });
    expect(change.summary).toMatch(/PATCH|PUT|DELETE/);
  });

  it('treats adding a method as compatible', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])], { methods: ['GET'] }));
    draft.generationConfig.methods = ['GET', 'POST'];

    expect(one(diffSchemas(active, draft), 'METHODS_CHANGED').severity).toBe('compatible');
  });

  it('ignores a pure reordering of methods', () => {
    // Sorted before comparison: the same set in a different order is not an edit.
    const { active, draft } = fork(
      ips([entity('User', [field('email')])], { methods: ['GET', 'POST'] }),
    );
    draft.generationConfig.methods = ['POST', 'GET'];
    expect(find(diffSchemas(active, draft), 'METHODS_CHANGED')).toEqual([]);
  });

  it('treats a generator selection change as cosmetic', () => {
    // Which downloads get produced. No caller of the hosted API can notice.
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.generationConfig.validators = ['zod', 'yup'];

    expect(one(diffSchemas(active, draft), 'GENERATORS_CHANGED')).toMatchObject({
      severity: 'cosmetic',
      aspect: 'none',
    });
  });

  it('treats a query-feature change as read-affecting', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.generationConfig.features = { search: true, filter: false, sort: false, include: false };

    expect(one(diffSchemas(active, draft), 'QUERY_FEATURES_CHANGED').aspect).toBe('read');
  });
});

describe('several edits at once', () => {
  it('reports each independently and in stable order', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email'), field('age')]), entity('Order', [field('total')])]),
    );
    draft.entities[0]!.fields[1]!.type = 'integer';
    draft.entities[0]!.name = 'Customer';
    draft.entities[1]!.fields[0]!.required = true;

    const first = diffSchemas(active, draft);
    const second = diffSchemas(active, draft);

    expect(first).toHaveLength(3);
    // Two reads of the same pair must not reshuffle, or a rendered list jumps.
    expect(second).toEqual(first);
  });

  it('scopes each change to the right entity', () => {
    // The precision impact analysis depends on: a change in Order must not be
    // attributed to User.
    const { active, draft } = fork(
      ips([entity('User', [field('email')]), entity('Order', [field('total')])]),
    );
    draft.entities[1]!.fields[0]!.type = 'decimal';

    const change = one(diffSchemas(active, draft), 'FIELD_TYPE_CHANGED');
    expect(change.entityName).toBe('Order');
    expect(change.entityId).toBe(draft.entities[1]!.id);
  });
});

describe('hasBreakingChanges and summariseChanges', () => {
  it('detects the presence of a breaking change', () => {
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';
    expect(hasBreakingChanges(diffSchemas(active, draft))).toBe(true);
  });

  it('is false when every change is safe', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.description = 'notes';
    draft.entities[0]!.fields.push(field('nickname'));
    expect(hasBreakingChanges(diffSchemas(active, draft))).toBe(false);
  });

  it('counts by severity', () => {
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';
    draft.entities[0]!.description = 'notes';

    expect(summariseChanges(diffSchemas(active, draft))).toEqual({
      breaking: 1,
      compatible: 0,
      cosmetic: 1,
    });
  });

  it('reports all zeroes for no changes', () => {
    expect(summariseChanges([])).toEqual({ breaking: 0, compatible: 0, cosmetic: 0 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  diffSchemas,
  highestRisk,
  needsAttention,
  summariseChanges,
  validationDirection,
  type SchemaChange,
} from './changes.js';
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
      risk: 'BREAKING',
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
      risk: 'BREAKING',
    });
  });
});

describe('requiredness', () => {
  it('is breaking when widened and write-only', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields[0]!.required = true;

    expect(one(diffSchemas(active, draft), 'FIELD_REQUIRED_CHANGED')).toMatchObject({
      // WARNING, not BREAKING: only callers that omitted the field break.
      risk: 'WARNING',
      // A GET response does not care whether the field was mandatory inbound.
      aspect: 'write',
      after: true,
    });
  });

  it('is compatible when relaxed', () => {
    const { active, draft } = fork(ips([entity('User', [field('email', { required: true })])]));
    draft.entities[0]!.fields[0]!.required = false;

    expect(one(diffSchemas(active, draft), 'FIELD_REQUIRED_CHANGED').risk).toBe('SAFE');
  });
});

describe('defaults', () => {
  /** The spec's read-vs-write example: a default reaches POST, never GET. */
  it('is compatible and write-only', () => {
    const { active, draft } = fork(ips([entity('User', [field('status', { default: 'active' })])]));
    draft.entities[0]!.fields[0]!.default = 'pending';

    expect(one(diffSchemas(active, draft), 'FIELD_DEFAULT_CHANGED')).toMatchObject({
      risk: 'SAFE',
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
    expect(change.risk).toBe('SAFE');
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
      risk: 'BREAKING',
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
    // WARNING: breaks only requests whose value falls outside the new bound.
    expect(change).toMatchObject({ risk: 'WARNING', aspect: 'write', before: 3, after: 5 });
    // Rule-level path, so the UI can point at the control that changed.
    expect(change.path).toBe('name.validation.min');
  });

  it('reports a removed rule as compatible', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('name', { validation: { regex: '^a' } })])]),
    );
    delete draft.entities[0]!.fields[0]!.validation.regex;

    expect(one(diffSchemas(active, draft), 'VALIDATION_REMOVED').risk).toBe('SAFE');
  });

  /** Spec §19's example: adding email validation to `User.email`. */
  it('reports an added rule as breaking', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields[0]!.validation.email = true;

    expect(one(diffSchemas(active, draft), 'VALIDATION_ADDED')).toMatchObject({
      risk: 'WARNING',
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

  /**
   * A loosened bound is SAFE, which the flat `WARNING` used to get wrong.
   *
   * `SAFE` is defined in this file's own header as "strictly additive… a relaxed
   * rule", so scoring `min: 8 → 3` as WARNING contradicted the vocabulary and
   * made the user acknowledge a change that cannot reject anything.
   */
  it('reports a loosened bound as safe, not as needing attention', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('name', { validation: { min: 8 } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.min = 3;

    expect(one(diffSchemas(active, draft), 'VALIDATION_CHANGED')).toMatchObject({
      risk: 'SAFE',
      before: 8,
      after: 3,
    });
  });

  it('reports a raised ceiling as safe and a lowered one as needing attention', () => {
    const relax = fork(ips([entity('User', [field('bio', { validation: { max: 10 } })])]));
    relax.draft.entities[0]!.fields[0]!.validation.max = 100;
    expect(one(diffSchemas(relax.active, relax.draft), 'VALIDATION_CHANGED').risk).toBe('SAFE');

    const tighten = fork(ips([entity('User', [field('bio', { validation: { max: 100 } })])]));
    tighten.draft.entities[0]!.fields[0]!.validation.max = 10;
    expect(one(diffSchemas(tighten.active, tighten.draft), 'VALIDATION_CHANGED').risk).toBe(
      'WARNING',
    );
  });

  it('keeps a changed regex at WARNING, because the direction is genuinely unknowable', () => {
    // Deciding this would mean comparing the languages two patterns accept.
    // `unknown` resolves to the cautious side rather than guessing.
    const { active, draft } = fork(
      ips([entity('User', [field('code', { validation: { regex: '^a' } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.regex = '^ab';

    expect(one(diffSchemas(active, draft), 'VALIDATION_CHANGED').risk).toBe('WARNING');
  });

  it('treats an exact length as a narrowing whichever way it moves', () => {
    // Values of the old length are rejected in both directions.
    for (const to of [4, 12]) {
      const { active, draft } = fork(
        ips([entity('User', [field('code', { validation: { length: 8 } })])]),
      );
      draft.entities[0]!.fields[0]!.validation.length = to;
      expect(one(diffSchemas(active, draft), 'VALIDATION_CHANGED').risk).toBe('WARNING');
    }
  });

  it('scores an arrayLength floor rising as a tightening even when the ceiling opens', () => {
    // A tighter floor rejects arrays that used to pass, however generous the
    // ceiling became — so the tightening outranks the relaxation.
    const { active, draft } = fork(
      ips([entity('User', [field('tags', { validation: { arrayLength: { min: 1, max: 5 } } })])]),
    );
    draft.entities[0]!.fields[0]!.validation.arrayLength = { min: 3, max: 50 };

    expect(one(diffSchemas(active, draft), 'VALIDATION_CHANGED').risk).toBe('WARNING');
  });

  it('treats a message as safe in either direction', () => {
    // Wire-visible only inside an error body; it can never reject a request.
    const { active, draft } = fork(ips([entity('User', [field('name')])]));
    draft.entities[0]!.fields[0]!.validation.message = 'Please supply a name';

    expect(one(diffSchemas(active, draft), 'VALIDATION_ADDED').risk).toBe('SAFE');
  });
});

describe('validationDirection', () => {
  /**
   * Tested directly as well as through the diff, because `classification.ts`
   * reads it too — it is the single reader of the evidence that keeps `risk` and
   * the three-value impact axis from disagreeing about the same edit.
   */
  it('scores appearance as a tightening and disappearance as a relaxation', () => {
    expect(validationDirection('min', undefined, 3)).toBe('tightened');
    expect(validationDirection('min', 3, undefined)).toBe('relaxed');
    expect(validationDirection('email', false, true)).toBe('tightened');
    expect(validationDirection('email', true, false)).toBe('relaxed');
  });

  it('scores numeric bounds by direction', () => {
    expect(validationDirection('min', 3, 8)).toBe('tightened');
    expect(validationDirection('min', 8, 3)).toBe('relaxed');
    expect(validationDirection('max', 100, 10)).toBe('tightened');
    expect(validationDirection('max', 10, 100)).toBe('relaxed');
  });

  it('returns unknown rather than guessing', () => {
    expect(validationDirection('regex', '^a', '^b')).toBe('unknown');
    // Non-numeric junk in a numeric bound: an old document can hold anything,
    // and this must not throw or invent an answer.
    expect(validationDirection('min', 'three', 8)).toBe('unknown');
    expect(validationDirection('max', {}, [])).toBe('unknown');
  });

  it('never throws on an arbitrary historical value', () => {
    for (const value of [null, undefined, 0, '', [], {}, NaN, Infinity]) {
      expect(() => validationDirection('arrayLength', value, value)).not.toThrow();
      expect(() => validationDirection('min', value, 1)).not.toThrow();
    }
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

    expect(one(diffSchemas(active, draft), 'FIELD_ADDED').risk).toBe('SAFE');
  });

  it('treats a new required field as breaking', () => {
    // Every existing request body that omits it now fails validation.
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields.push(field('phone', { required: true }));

    expect(one(diffSchemas(active, draft), 'FIELD_ADDED').risk).toBe('WARNING');
  });

  it('treats a removed field as breaking', () => {
    const { active, draft } = fork(ips([entity('User', [field('email'), field('age')])]));
    draft.entities[0]!.fields.splice(1, 1);

    expect(one(diffSchemas(active, draft), 'FIELD_REMOVED')).toMatchObject({
      risk: 'BREAKING',
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
    // ROUTING, not BREAKING: the endpoints still work, at a different URL.
    expect(change).toMatchObject({ risk: 'ROUTING', aspect: 'routing' });
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
      risk: 'SAFE',
      entityName: 'Order',
    });
  });

  /**
   * The payload carries what the entity contains, so a comparison view can
   * expand "Order added" into its fields and relations (§10).
   *
   * As a payload rather than as per-field `FIELD_ADDED` rows: a 51-field entity
   * would otherwise emit 52 changes for one addition, which is the flat-row
   * problem §37 forbids, and every summary would double-count.
   */
  it('carries what an added entity contains, without emitting a change per field', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities.push(
      entity('Order', [field('total', { type: 'decimal', required: true })], {
        relations: [
          {
            name: 'buyer',
            kind: 'belongsTo',
            target: 'User',
            localField: 'userId',
            foreignField: 'id',
            required: false,
            onDelete: 'restrict',
          },
        ],
      }),
    );
    ensureSchemaIds(draft);

    const changes = diffSchemas(active, draft);
    const added = one(changes, 'ENTITY_ADDED');
    const shape = added.after as {
      name: string;
      fields: { name: string; type: string; required: boolean }[];
      relations: { name: string; kind: string; target: string }[];
    };

    expect(shape.name).toBe('Order');
    // `toMatchObject`, because the stable ids travel too — which is the point:
    // a comparison view can key its rows on them rather than on names.
    expect(shape.fields).toMatchObject([{ name: 'total', type: 'decimal', required: true }]);
    expect(shape.relations).toMatchObject([{ name: 'buyer', kind: 'belongsTo', target: 'User' }]);
    expect(shape.fields[0]).toHaveProperty('id');

    // One row for the entity, not one per field.
    expect(find(changes, 'FIELD_ADDED')).toEqual([]);
    expect(find(changes, 'RELATION_ADDED')).toEqual([]);
  });

  it('carries what a removed entity contained, so the loss is inspectable', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email')]), entity('Order', [field('total'), field('note')])]),
    );
    draft.entities.splice(1, 1);

    const shape = one(diffSchemas(active, draft), 'ENTITY_REMOVED').before as {
      name: string;
      fields: { name: string }[];
    };
    // The identity field materialization would add is absent here because this
    // fixture is not materialized — what matters is that the authored fields
    // travel with the change rather than being lost with the entity.
    expect(shape.name).toBe('Order');
    expect(shape.fields.map((f) => f.name)).toEqual(['total', 'note']);
  });

  it('reports a removed entity as breaking', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email')]), entity('Order', [field('total')])]),
    );
    draft.entities.splice(1, 1);

    expect(one(diffSchemas(active, draft), 'ENTITY_REMOVED')).toMatchObject({
      risk: 'BREAKING',
      aspect: 'routing',
      entityName: 'Order',
    });
  });

  it('treats a description edit as cosmetic and reaching nothing', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.description = 'Application user';

    expect(one(diffSchemas(active, draft), 'ENTITY_DESCRIPTION_CHANGED')).toMatchObject({
      risk: 'INFO',
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
      risk: 'ROUTING',
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

  /**
   * A relation rename used to produce NO change at all.
   *
   * `diffRelations` compared kind, target, join fields, onDelete and required —
   * never the name. So renaming `classroom` to `room` was invisible: the diff
   * said nothing changed while `?include=classroom` started returning 400. §1 of
   * the Phase 2 spec forbids a rename reading as delete-plus-create; reading as
   * *nothing* is worse, because there is no wrong answer to notice.
   */
  it('reports a renamed relation, which used to be silent', () => {
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.name = 'room';

    const change = one(diffSchemas(active, draft), 'RELATION_RENAMED');
    expect(change).toMatchObject({
      // Same risk as RELATION_REMOVED: the runtime rejects an unknown
      // `?include=` with a 400 rather than ignoring it, so the old key fails
      // hard rather than degrading.
      risk: 'BREAKING',
      // `read`, not `both` — narrower than its siblings on purpose. A rename
      // leaves `localField` alone, so no request body moves.
      aspect: 'read',
      before: 'classroom',
      after: 'room',
    });
    expect(change.summary).toContain('?include=classroom');
  });

  it('reports a rename as a rename, not a removal plus an addition', () => {
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.name = 'room';

    const changes = diffSchemas(active, draft);
    expect(find(changes, 'RELATION_REMOVED')).toHaveLength(0);
    expect(find(changes, 'RELATION_ADDED')).toHaveLength(0);
  });

  it('reports a removed relation as breaking', () => {
    // `?include=classroom` stops resolving for every existing caller.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations = [];

    expect(one(diffSchemas(active, draft), 'RELATION_REMOVED')).toMatchObject({
      risk: 'BREAKING',
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
      risk: 'BREAKING',
    });
  });

  it('reports a cardinality change as breaking', () => {
    // Decides whether an expansion is an object or an array.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.kind = 'hasMany';
    expect(one(diffSchemas(active, draft), 'RELATION_KIND_CHANGED').risk).toBe('BREAKING');
  });

  it('treats an onDelete change as compatible and write-only', () => {
    // Only observable through DELETE, and only in what happens to the far side.
    const { active, draft } = withRelation();
    draft.entities[0]!.relations![0]!.onDelete = 'cascade';

    expect(one(diffSchemas(active, draft), 'RELATION_ON_DELETE_CHANGED')).toMatchObject({
      risk: 'SAFE',
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

    expect(one(diffSchemas(active, draft), 'RELATION_ADDED').risk).toBe('SAFE');
  });
});

describe('generation config', () => {
  it('treats removing a method as breaking and routing-affecting', () => {
    // Endpoints stop existing, which is not a read or a write change — it is the
    // surface itself changing.
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.generationConfig.methods = ['GET', 'POST'];

    const change = one(diffSchemas(active, draft), 'METHODS_CHANGED');
    expect(change).toMatchObject({ risk: 'BREAKING', aspect: 'routing' });
    expect(change.summary).toMatch(/PATCH|PUT|DELETE/);
  });

  it('treats adding a method as compatible', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])], { methods: ['GET'] }));
    draft.generationConfig.methods = ['GET', 'POST'];

    expect(one(diffSchemas(active, draft), 'METHODS_CHANGED').risk).toBe('SAFE');
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
      risk: 'INFO',
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

describe('highestRisk, needsAttention and summariseChanges', () => {
  it('finds the worst risk in a set', () => {
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';
    draft.entities[0]!.description = 'notes';
    expect(highestRisk(diffSchemas(active, draft))).toBe('BREAKING');
  });

  it('ranks ROUTING above WARNING and below BREAKING', () => {
    // Both demand action; the ordering is presentational, not a claim that a
    // moved URL hurts less than a changed payload.
    expect(highestRisk([{ risk: 'WARNING' }, { risk: 'ROUTING' }] as never)).toBe('ROUTING');
    expect(highestRisk([{ risk: 'ROUTING' }, { risk: 'BREAKING' }] as never)).toBe('BREAKING');
  });

  it('returns null for no changes', () => {
    expect(highestRisk([])).toBeNull();
  });

  /**
   * WARNING counts as needing attention. A dialog that only warns on BREAKING
   * would wave through making a field required — which rejects every request
   * body that omitted it.
   */
  it('treats WARNING as needing attention', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.fields[0]!.required = true;

    const changes = diffSchemas(active, draft);
    expect(changes[0]?.risk).toBe('WARNING');
    expect(needsAttention(changes)).toBe(true);
  });

  it('is quiet when every change is SAFE or INFO', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    draft.entities[0]!.description = 'notes';
    draft.entities[0]!.fields.push(field('nickname'));

    expect(needsAttention(diffSchemas(active, draft))).toBe(false);
  });

  it('counts by risk', () => {
    const { active, draft } = fork(ips([entity('User', [field('age')])]));
    draft.entities[0]!.fields[0]!.type = 'integer';
    draft.entities[0]!.description = 'notes';

    expect(summariseChanges(diffSchemas(active, draft))).toEqual({
      SAFE: 0,
      INFO: 1,
      WARNING: 0,
      ROUTING: 0,
      BREAKING: 1,
    });
  });

  it('reports all zeroes for no changes', () => {
    expect(summariseChanges([])).toEqual({
      SAFE: 0,
      INFO: 0,
      WARNING: 0,
      ROUTING: 0,
      BREAKING: 0,
    });
  });
});

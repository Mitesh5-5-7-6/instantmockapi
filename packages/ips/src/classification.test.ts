import { describe, it, expect } from 'vitest';

import { CHANGE_KINDS, diffSchemas, type ChangeKind, type SchemaChange } from './changes.js';
import {
  CHANGE_IMPACTS,
  classifyChangeType,
  classifyImpact,
  summariseChangeTypes,
  summariseImpact,
  worstImpact,
} from './classification.js';
import { ensureSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
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
  return { name, fields, identity: { field: 'id', style: 'int' }, ...over };
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
      features: { search: true, filter: true, sort: true, include: true },
      ...config,
    },
  } as InternalProjectSchema;
}

function fork(active: InternalProjectSchema) {
  const materialized = materializeRelations(active);
  ensureSchemaIds(materialized);
  return {
    active: materialized,
    draft: JSON.parse(JSON.stringify(materialized)) as InternalProjectSchema,
  };
}

/**
 * Address a field by name.
 *
 * Not by index. `materializeRelations` unshifts the identity field and appends
 * derived foreign keys, so `fields[0]` is `id` — and every positional reference
 * silently edits the wrong field. Five tests in the first draft of this file
 * asserted against an edit that never happened, and one of them "passed" by
 * retyping the identity field, which `materializeRelations` then reconciled
 * straight back.
 */
function fieldNamed(draft: InternalProjectSchema, entityName: string, fieldName: string): Field {
  const found = draft.entities
    .find((candidate) => candidate.name === entityName)
    ?.fields.find((candidate) => candidate.name === fieldName);
  if (!found) {
    throw new Error(`no field ${entityName}.${fieldName}`);
  }
  return found;
}

/** The one change of a given kind produced by an edit. */
function changeOf(
  kind: ChangeKind,
  edit: (draft: InternalProjectSchema) => void,
  base: InternalProjectSchema = ips([entity('User', [field('email'), field('age')])]),
): SchemaChange {
  const { active, draft } = fork(base);
  edit(draft);
  const matches = diffSchemas(active, draft).filter((change) => change.kind === kind);
  expect(matches, `expected exactly one ${kind}, got ${matches.length}`).toHaveLength(1);
  return matches[0]!;
}

describe('the table is total', () => {
  /**
   * The guard that makes this a projection rather than a second axis.
   *
   * `IMPACT_RULES` and `TYPE_RULES` are exhaustive `Record<ChangeKind, …>`, so a
   * new kind is a compile error until classified. This asserts the runtime half:
   * every declared kind resolves to a real value, including through the payload-
   * dependent rules, whose inputs are `unknown`.
   */
  it('classifies every declared change kind', () => {
    for (const kind of CHANGE_KINDS) {
      const bare = { kind, risk: 'SAFE', aspect: 'none', summary: '' } as SchemaChange;
      expect(CHANGE_IMPACTS, kind).toContain(classifyImpact(bare));
      expect(['ADDED', 'REMOVED', 'MODIFIED', 'RENAMED'], kind).toContain(classifyChangeType(bare));
    }
  });

  it('never throws on a change carrying arbitrary payloads', () => {
    // These run over `Version.ipsSnapshot`, which is `Mixed` and can hold
    // anything any past version of the code wrote. A crash here would turn
    // comparing two old snapshots into a 500.
    const payloads: unknown[] = [undefined, null, 0, '', [], {}, NaN, 'nope', [1, 2], { a: 1 }];
    for (const kind of CHANGE_KINDS) {
      for (const value of payloads) {
        const change = {
          kind,
          risk: 'SAFE',
          aspect: 'none',
          summary: '',
          before: value,
          after: value,
        } as SchemaChange;
        expect(() => classifyImpact(change), `${kind} with ${JSON.stringify(value)}`).not.toThrow();
      }
    }
  });

  it('resolves an unreadable payload to the worse candidate, never the safer one', () => {
    // Reporting a breaking change as safe is the one direction that hurts.
    const unreadable = {
      kind: 'FIELD_REQUIRED_CHANGED',
      risk: 'SAFE',
      aspect: 'write',
      summary: '',
      after: 'not a boolean',
    } as SchemaChange;
    expect(classifyImpact(unreadable)).toBe('BREAKING');
  });
});

describe('the §12 pairs a risk-keyed map could not express', () => {
  /**
   * This is why the table is keyed on `kind` and re-reads the payload.
   *
   * `changes.ts` scores `required: false → true` and a tightened `min` both as
   * `WARNING`, but §12 wants the first BREAKING and the second only potentially
   * so. A `risk → impact` lookup cannot tell them apart.
   */
  it('separates required-now from a tightened bound, which share a risk', () => {
    const required = changeOf('FIELD_REQUIRED_CHANGED', (draft) => {
      fieldNamed(draft, 'User', 'email').required = true;
    });
    const tightened = changeOf(
      'VALIDATION_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').validation.min = 8;
      },
      ips([entity('User', [field('email', { validation: { min: 3 } })])]),
    );

    expect(required.risk).toBe('WARNING');
    expect(tightened.risk).toBe('WARNING');

    expect(classifyImpact(required)).toBe('BREAKING');
    expect(classifyImpact(tightened)).toBe('POTENTIALLY_BREAKING');
  });

  it('calls a relaxed bound non-breaking', () => {
    const relaxed = changeOf(
      'VALIDATION_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').validation.min = 3;
      },
      ips([entity('User', [field('email', { validation: { min: 8 } })])]),
    );
    expect(classifyImpact(relaxed)).toBe('NON_BREAKING');
  });

  it('calls an optional new field non-breaking and a required one breaking', () => {
    const optional = changeOf('FIELD_ADDED', (draft) => {
      draft.entities[0]!.fields.push(field('nickname'));
    });
    const required = changeOf('FIELD_ADDED', (draft) => {
      draft.entities[0]!.fields.push(field('nickname', { required: true }));
    });

    expect(classifyImpact(optional)).toBe('NON_BREAKING');
    expect(classifyImpact(required)).toBe('BREAKING');
  });

  it('calls dropping requiredness non-breaking', () => {
    const relaxed = changeOf(
      'FIELD_REQUIRED_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').required = false;
      },
      ips([entity('User', [field('email', { required: true })])]),
    );
    expect(classifyImpact(relaxed)).toBe('NON_BREAKING');
  });
});

describe('where ROUTING lands', () => {
  /**
   * Nowhere, as a level — and that is itself the proof the axes are orthogonal.
   *
   * Three `ROUTING` kinds land in two different impact buckets, so no
   * `risk → impact` map exists. `ROUTING` answers "what is the remedy"; this
   * axis answers "do callers break".
   */
  it('maps an entity rename to BREAKING, because the URL moves', () => {
    const rename = changeOf('ENTITY_RENAMED', (draft) => {
      draft.entities[0]!.name = 'Client';
    });
    expect(rename.risk).toBe('ROUTING');
    // §12 lists "endpoint path changed: BREAKING", and the hosted route is
    // derived from the entity name.
    expect(classifyImpact(rename)).toBe('BREAKING');
  });

  it('maps a removed method to BREAKING and an added one to NON_BREAKING', () => {
    const base = ips([entity('User', [field('email')])], { methods: ['GET', 'POST'] });

    const removed = changeOf(
      'METHODS_CHANGED',
      (draft) => {
        draft.generationConfig.methods = ['GET'];
      },
      base,
    );
    const added = changeOf(
      'METHODS_CHANGED',
      (draft) => {
        draft.generationConfig.methods = ['GET', 'POST', 'DELETE'];
      },
      base,
    );

    expect(classifyImpact(removed)).toBe('BREAKING');
    expect(classifyImpact(added)).toBe('NON_BREAKING');
    // Same kind, same axis, two different answers — read from the payload.
    expect(removed.kind).toBe(added.kind);
  });
});

describe('the disagreements that are why the two axes are never shown together', () => {
  it('calls a changed default SAFE on one axis and potentially breaking on the other', () => {
    // Nothing starts returning 422 — so SAFE is right. But a write that omitted
    // the key now stores a different value, and a reader may depend on the old
    // one — so potentially-breaking is also right. Both true, of different
    // questions; adjacent in one row they read as a contradiction.
    const change = changeOf('FIELD_DEFAULT_CHANGED', (draft) => {
      fieldNamed(draft, 'User', 'email').default = 'unknown@example.com';
    });
    expect(change.risk).toBe('SAFE');
    expect(classifyImpact(change)).toBe('POTENTIALLY_BREAKING');
  });

  it('calls a cascade delete SAFE on one axis and potentially breaking on the other', () => {
    const base = ips([
      entity('Order', [field('total')], {
        relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
      }),
      entity('User', [field('email')]),
    ]);
    const change = changeOf(
      'RELATION_ON_DELETE_CHANGED',
      (draft) => {
        draft.entities[0]!.relations![0]!.onDelete = 'cascade';
      },
      base,
    );
    // A DELETE that used to be refused with a 409 now succeeds and destroys
    // related records. Nothing breaks; something irreversible starts happening.
    expect(change.risk).toBe('SAFE');
    expect(classifyImpact(change)).toBe('POTENTIALLY_BREAKING');
  });
});

describe('metadata flags', () => {
  const base = ips([entity('User', [field('email')])]);

  it('treats newly-unique as potentially breaking', () => {
    // Writes that used to succeed now collide with a 409.
    const change = changeOf(
      'FIELD_META_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').meta = { unique: true };
      },
      base,
    );
    expect(classifyImpact(change)).toBe('POTENTIALLY_BREAKING');
  });

  it('treats withdrawn searchability as potentially breaking', () => {
    const change = changeOf(
      'FIELD_META_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').meta = {};
      },
      ips([entity('User', [field('email', { meta: { searchable: true } })])]),
    );
    expect(classifyImpact(change)).toBe('POTENTIALLY_BREAKING');
  });

  it('treats uniqueness being dropped as non-breaking', () => {
    const change = changeOf(
      'FIELD_META_CHANGED',
      (draft) => {
        fieldNamed(draft, 'User', 'email').meta = {};
      },
      ips([entity('User', [field('email', { meta: { unique: true } })])]),
    );
    expect(classifyImpact(change)).toBe('NON_BREAKING');
  });
});

describe('query features', () => {
  it('treats a withdrawn feature as potentially breaking and an added one as safe', () => {
    const base = ips([entity('User', [field('email')])], {
      features: { search: true, filter: true, sort: false, include: false },
    });

    const withdrawn = changeOf(
      'QUERY_FEATURES_CHANGED',
      (draft) => {
        draft.generationConfig.features = {
          search: false,
          filter: true,
          sort: false,
          include: false,
        };
      },
      base,
    );
    const granted = changeOf(
      'QUERY_FEATURES_CHANGED',
      (draft) => {
        draft.generationConfig.features = {
          search: true,
          filter: true,
          sort: true,
          include: false,
        };
      },
      base,
    );

    expect(classifyImpact(withdrawn)).toBe('POTENTIALLY_BREAKING');
    expect(classifyImpact(granted)).toBe('NON_BREAKING');
  });
});

describe('the rename cascade', () => {
  it('does not count a relation following a rename as breaking', () => {
    // The retarget is the echo of an entity rename already reported at ROUTING.
    // Counting it as breaking would make one rename read as N breaking changes.
    const base = ips([
      entity('Order', [field('total')], {
        relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
      }),
      entity('User', [field('email')]),
    ]);
    const echo = changeOf(
      'RELATION_TARGET_CHANGED',
      (draft) => {
        draft.entities[1]!.name = 'Client';
        draft.entities[0]!.relations![0]!.target = 'Client';
      },
      base,
    );
    expect(classifyImpact(echo)).toBe('NON_BREAKING');
  });

  it('still counts a genuine retarget as breaking', () => {
    const base = ips([
      entity('Order', [field('total')], {
        relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
      }),
      entity('User', [field('email')]),
      entity('Vendor', [field('title')]),
    ]);
    const real = changeOf(
      'RELATION_TARGET_CHANGED',
      (draft) => {
        draft.entities[0]!.relations![0]!.target = 'Vendor';
      },
      base,
    );
    expect(classifyImpact(real)).toBe('BREAKING');
  });
});

describe('change types', () => {
  it('counts a validation rule as a modification of its field, not an addition', () => {
    // Otherwise "2 added" in one summary would mean both "two new fields" and
    // "two new rules on one field".
    const change = changeOf('VALIDATION_ADDED', (draft) => {
      fieldNamed(draft, 'User', 'email').validation.email = true;
    });
    expect(classifyChangeType(change)).toBe('MODIFIED');
  });

  it('counts renames separately from adds and removes', () => {
    const rename = changeOf('ENTITY_RENAMED', (draft) => {
      draft.entities[0]!.name = 'Client';
    });
    expect(classifyChangeType(rename)).toBe('RENAMED');
  });
});

describe('aggregates', () => {
  it('reports null for an empty set rather than a default bucket', () => {
    expect(worstImpact([])).toBeNull();
  });

  it('takes the worst impact, not the first or the most common', () => {
    const { active, draft } = fork(ips([entity('User', [field('email'), field('age')])]));
    draft.entities[0]!.fields.push(field('nickname'));
    fieldNamed(draft, 'User', 'email').type = 'integer';

    const changes = diffSchemas(active, draft);
    expect(summariseImpact(changes).NON_BREAKING).toBeGreaterThan(0);
    expect(worstImpact(changes)).toBe('BREAKING');
  });

  it('zero-initialises every bucket so callers never check for absence', () => {
    expect(summariseImpact([])).toEqual({
      NON_BREAKING: 0,
      POTENTIALLY_BREAKING: 0,
      BREAKING: 0,
    });
    expect(summariseChangeTypes([])).toEqual({
      ADDED: 0,
      REMOVED: 0,
      MODIFIED: 0,
      RENAMED: 0,
    });
  });

  it('counts every change exactly once across the buckets', () => {
    const { active, draft } = fork(ips([entity('User', [field('email')])]));
    fieldNamed(draft, 'User', 'email').required = true;
    draft.entities[0]!.fields.push(field('age', { type: 'integer' }));
    draft.entities[0]!.name = 'Client';

    const changes = diffSchemas(active, draft);
    const impact = summariseImpact(changes);
    const types = summariseChangeTypes(changes);

    const total = (counts: Record<string, number>) =>
      Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total(impact)).toBe(changes.length);
    expect(total(types)).toBe(changes.length);
  });
});

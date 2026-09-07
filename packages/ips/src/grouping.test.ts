import { describe, it, expect } from 'vitest';

import { diffSchemas } from './changes.js';
import { groupChanges, treeImpact, type ChangeTree } from './grouping.js';
import { buildDependencyGraph } from './graph.js';
import { ensureSchemaIds } from './ids.js';
import { analyseImpact } from './impact.js';
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

function ips(entities: Entity[]): InternalProjectSchema {
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

/** Group the changes an edit produces, with impact attached. */
function treeFor(
  base: InternalProjectSchema,
  edit: (draft: InternalProjectSchema) => void,
  withImpact = true,
): ChangeTree {
  const { active, draft } = fork(base);
  edit(draft);
  const changes = diffSchemas(active, draft);
  const impact = analyseImpact(changes, buildDependencyGraph(draft));
  return groupChanges(changes, withImpact ? impact : undefined);
}

const named = (tree: ChangeTree, name: string) =>
  tree.entities.find((group) => group.name === name)!;

describe('the hierarchy §37 asks for', () => {
  /**
   * > Do not display 50 separate flat change rows when they belong to one
   * > entity.
   *
   * Four edits to one entity collapse into one group with three field
   * sub-groups, not seven peers.
   */
  it('collapses many changes to one entity into one group', () => {
    const tree = treeFor(
      ips([entity('User', [field('email'), field('age'), field('bio')])]),
      (draft) => {
        const user = draft.entities[0]!;
        user.fields.find((f) => f.name === 'email')!.required = true;
        user.fields.find((f) => f.name === 'age')!.type = 'integer';
        user.fields.find((f) => f.name === 'bio')!.validation.min = 3;
        user.description = 'People';
      },
    );

    expect(tree.entities).toHaveLength(1);
    const user = named(tree, 'User');
    expect(user.fields).toHaveLength(3);
    // The description edit is about the entity, not about any field.
    expect(user.own.map((entry) => entry.change.kind)).toEqual(['ENTITY_DESCRIPTION_CHANGED']);
  });

  it('groups every change to one field under that field', () => {
    // A type change, a requiredness change and a validation rule on the same
    // field are one thing to look at, not three.
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      const email = draft.entities[0]!.fields.find((f) => f.name === 'email')!;
      email.type = 'integer';
      email.required = true;
      email.validation.min = 3;
    });

    const email = named(tree, 'User').fields.find((group) => group.name === 'email')!;
    expect(email.changes.map((entry) => entry.change.kind).sort()).toEqual([
      'FIELD_REQUIRED_CHANGED',
      'FIELD_TYPE_CHANGED',
      'VALIDATION_ADDED',
    ]);
    expect(email.counts.total).toBe(3);
  });

  /**
   * `diffField` overwrites `path` for validation rules with a synthetic pointer
   * — `email.validation.min` — so grouping on it naively made every rule its own
   * pseudo-field. A field with a type change and two tightened rules rendered as
   * three sibling groups, which is exactly the flat-row problem §37 forbids.
   */
  it('groups validation rules under their field, not as sibling pseudo-fields', () => {
    const tree = treeFor(ips([entity('User', [field('name'), field('bio')])]), (draft) => {
      const name = draft.entities[0]!.fields.find((f) => f.name === 'name')!;
      name.validation.min = 3;
      name.validation.max = 40;
      name.validation.email = true;
    });

    const user = named(tree, 'User');
    // One group, three rules — not three groups.
    expect(user.fields.map((group) => group.path)).toEqual(['name']);
    expect(user.fields[0]!.counts.total).toBe(3);
  });

  it('nests relation changes under their declaring entity, not at project level', () => {
    // `diffRelations` stamps `entityName` on every relation change, so they
    // belong in the tree — unlike config changes, which have no entity at all.
    const tree = treeFor(
      ips([
        entity('Order', [field('total')], {
          relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
        }),
        entity('User', [field('email')]),
      ]),
      (draft) => {
        draft.entities[0]!.relations![0]!.name = 'purchaser';
      },
    );

    const order = named(tree, 'Order');
    expect(order.relations.map((group) => group.name)).toEqual(['purchaser']);
    expect(order.relations[0]!.previousName).toBe('buyer');
    expect(tree.project.changes).toEqual([]);
  });

  it('puts config changes in the project group, which has no entity', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.generationConfig.mockRecords = 50;
      draft.generationConfig.methods = ['GET'];
    });

    expect(tree.entities).toEqual([]);
    expect(tree.project.changes.map((entry) => entry.change.kind).sort()).toEqual([
      'METHODS_CHANGED',
      'MOCK_RECORDS_CHANGED',
    ]);
  });

  it('reports null project impact for an empty project group, not a reassuring badge', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    });
    expect(tree.project.changes).toEqual([]);
    expect(tree.project.impact).toBeNull();
  });
});

describe('field identity', () => {
  it('keys fields on the dotted path, so a nested id is not merged with the identity', () => {
    // `id` and `address.id` are different fields. Grouping on the bare name
    // would put two unrelated changes under one header.
    const tree = treeFor(
      ips([
        entity('User', [
          field('email'),
          field('address', { type: 'object', children: [field('id')] }),
        ]),
      ]),
      (draft) => {
        const address = draft.entities[0]!.fields.find((f) => f.name === 'address')!;
        address.children[0]!.type = 'integer';
      },
    );

    const paths = named(tree, 'User').fields.map((group) => group.path);
    expect(paths).toEqual(['address.id']);
  });

  it('gives every group a key even when nothing carries a stable id', () => {
    // Keys are React's row identity; a collision would make two rows share
    // state and an undefined key would make the list re-mount on every render.
    const before = ips([entity('User', [field('email')])]);
    const after = JSON.parse(JSON.stringify(before)) as InternalProjectSchema;
    after.entities[0]!.fields[0]!.type = 'integer';

    const tree = groupChanges(diffSchemas(before, after, { match: 'auto' }));
    const keys = tree.entities.flatMap((group) => [group.key, ...group.fields.map((f) => f.key)]);

    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('group status', () => {
  it('reads an added entity as added, whatever else it contains', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities.push(entity('Order', [field('total')]));
      ensureSchemaIds(draft);
    });
    expect(named(tree, 'Order').status).toBe('added');
  });

  it('reads a renamed entity as renamed and carries the old name', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.name = 'Client';
    });
    const group = named(tree, 'Client');
    expect(group.status).toBe('renamed');
    expect(group.previousName).toBe('User');
  });

  it('reads a field that only changed as modified', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    });
    expect(named(tree, 'User').fields[0]!.status).toBe('modified');
    // The entity itself did not change — only something inside it.
    expect(named(tree, 'User').status).toBe('modified');
  });

  it('reads a removed field as removed', () => {
    const tree = treeFor(ips([entity('User', [field('email'), field('age')])]), (draft) => {
      draft.entities[0]!.fields = draft.entities[0]!.fields.filter((f) => f.name !== 'age');
    });
    const age = named(tree, 'User').fields.find((group) => group.name === 'age')!;
    expect(age.status).toBe('removed');
  });
});

describe('counts', () => {
  it('rolls field and relation counts up into the entity', () => {
    const tree = treeFor(
      ips([
        entity('Order', [field('total'), field('note')], {
          relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
        }),
        entity('User', [field('email')]),
      ]),
      (draft) => {
        const order = draft.entities[0]!;
        order.fields.find((f) => f.name === 'total')!.type = 'decimal';
        order.fields.find((f) => f.name === 'note')!.required = true;
        order.relations![0]!.onDelete = 'cascade';
      },
    );

    const order = named(tree, 'Order');
    const fromChildren =
      order.fields.reduce((sum, group) => sum + group.counts.total, 0) +
      order.relations.reduce((sum, group) => sum + group.counts.total, 0);

    expect(order.counts.total).toBe(order.own.length + fromChildren);
    expect(order.counts.total).toBe(3);
  });

  it('counts every change exactly once across the whole tree', () => {
    const { active, draft } = fork(
      ips([
        entity('Order', [field('total')], {
          relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
        }),
        entity('User', [field('email')]),
      ]),
    );
    draft.entities[0]!.fields.find((f) => f.name === 'total')!.type = 'decimal';
    draft.entities[1]!.name = 'Client';
    draft.entities[0]!.relations![0]!.target = 'Client';
    draft.generationConfig.mockRecords = 42;

    const changes = diffSchemas(active, draft);
    const tree = groupChanges(changes);

    const inTree =
      tree.project.changes.length +
      tree.entities.reduce(
        (sum, group) =>
          sum +
          group.own.length +
          group.fields.reduce((n, f) => n + f.changes.length, 0) +
          group.relations.reduce((n, r) => n + r.changes.length, 0),
        0,
      );

    expect(inTree).toBe(changes.length);
    expect(tree.counts.total).toBe(changes.length);
  });

  it('takes a group header from the worst impact beneath it', () => {
    const tree = treeFor(ips([entity('User', [field('email'), field('age')])]), (draft) => {
      // One breaking, one not.
      draft.entities[0]!.fields.find((f) => f.name === 'age')!.type = 'integer';
      draft.entities[0]!.fields.push(field('nickname'));
      ensureSchemaIds(draft);
    });

    const user = named(tree, 'User');
    expect(user.counts.breaking).toBeGreaterThan(0);
    expect(user.counts.nonBreaking).toBeGreaterThan(0);
    // The header must not read "non-breaking" because one row is.
    expect(user.impact).toBe('BREAKING');
  });

  it('reports the worst impact in the tree, or null for no changes', () => {
    expect(treeImpact(groupChanges([]))).toBeNull();

    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    });
    expect(treeImpact(tree)).toBe('BREAKING');
  });
});

describe('endpoints', () => {
  it('attaches the endpoints an entity reaches, from the impact report', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    });

    const endpoints = named(tree, 'User').endpoints;
    expect(endpoints.length).toBeGreaterThan(0);
    // The precision rule holds through the grouping too: DELETE sends a path
    // parameter and returns no body, so a field change cannot reach it.
    expect(endpoints.some((endpoint) => endpoint.method === 'DELETE')).toBe(false);
  });

  it('leaves endpoints empty when no impact report was supplied', () => {
    // The commit dialog renders its own affected list, so it does not need this
    // and must not be forced to compute an impact report to group changes.
    const tree = treeFor(
      ips([entity('User', [field('email')])]),
      (draft) => {
        draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
      },
      false,
    );
    expect(named(tree, 'User').endpoints).toEqual([]);
  });
});

describe('ordering', () => {
  it('keeps entities in document order rather than sorting by severity', () => {
    // A list that reshuffles between reads is worse than one not sorted by
    // severity. Sorting is a UI affordance applied on top.
    const tree = treeFor(
      ips([
        entity('Alpha', [field('a')]),
        entity('Beta', [field('b')]),
        entity('Gamma', [field('c')]),
      ]),
      (draft) => {
        // Gamma is breaking, Alpha merely additive — document order must win.
        draft.entities[2]!.fields.find((f) => f.name === 'c')!.type = 'integer';
        draft.entities[0]!.fields.push(field('extra'));
        ensureSchemaIds(draft);
      },
    );

    expect(tree.entities.map((group) => group.name)).toEqual(['Alpha', 'Gamma']);
  });
});

describe('the name-matched badge', () => {
  it('marks only the groups that were paired by name', () => {
    // The badge belongs on the group that earned it, not over the whole page:
    // one entity of twelve being uncertain must not caveat the other eleven.
    const before = ips([entity('User', [field('email')])]);
    const after = JSON.parse(JSON.stringify(before)) as InternalProjectSchema;
    after.entities[0]!.fields[0]!.type = 'integer';

    const tree = groupChanges(diffSchemas(before, after, { match: 'auto' }));
    expect(named(tree, 'User').matchedBy).toBe('name');
    expect(named(tree, 'User').fields[0]!.matchedBy).toBe('name');
  });

  it('reports id-matching when both sides carry ids', () => {
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    });
    expect(named(tree, 'User').matchedBy).toBe('id');
  });
});

describe('an added entity', () => {
  it('is one group with no per-field rows', () => {
    // `diffSchemas` deliberately skips the field loop for a new entity, so a
    // 51-field entity is one change rather than 52. The contents travel on the
    // change payload instead, which is what §10 expands.
    const tree = treeFor(ips([entity('User', [field('email')])]), (draft) => {
      draft.entities.push(entity('Order', [field('total'), field('note'), field('ref')]));
      ensureSchemaIds(draft);
    });

    const order = named(tree, 'Order');
    expect(order.own).toHaveLength(1);
    expect(order.fields).toEqual([]);
    expect(order.counts.total).toBe(1);

    // As authored: this edit pushes the entity and mints ids without running
    // `materializeRelations`, so the derived identity field is not there yet.
    const shape = order.own[0]!.change.after as { fields: { name: string }[] };
    expect(shape.fields.map((f) => f.name)).toEqual(['total', 'note', 'ref']);
  });
});

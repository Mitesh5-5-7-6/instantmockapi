import { describe, it, expect } from 'vitest';
import {
  ID_PREFIX,
  SCHEMA_ID_PATTERN,
  collectSchemaIds,
  duplicateSchemaIds,
  ensureSchemaIds,
  isSchemaId,
  newSchemaId,
} from './ids.js';
import type { Entity, Field, InternalProjectSchema } from './types.js';

function field(name: string, type: Field['type'] = 'string', children: Field[] = []): Field {
  return { name, type, required: true, default: null, children, validation: {}, meta: {} };
}

function entity(name: string, fields: Field[], relations?: Entity['relations']): Entity {
  return { name, fields, ...(relations ? { relations } : {}) };
}

function ips(entities: Entity[]): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities,
    generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 5 },
  };
}

describe('newSchemaId', () => {
  it('prefixes by kind', () => {
    expect(newSchemaId('entity')).toMatch(/^ent_/);
    expect(newSchemaId('field')).toMatch(/^fld_/);
    expect(newSchemaId('relation')).toMatch(/^rel_/);
    expect(newSchemaId('endpoint')).toMatch(/^ep_/);
  });

  it('matches its own pattern', () => {
    // A validator will use SCHEMA_ID_PATTERN to reject a malformed id, so the
    // minter and the pattern must not drift.
    for (const kind of ['entity', 'field', 'relation', 'endpoint'] as const) {
      expect(newSchemaId(kind)).toMatch(SCHEMA_ID_PATTERN);
    }
  });

  it('does not collide across many mints', () => {
    // 8 random bytes. Nothing in the database enforces uniqueness for these —
    // unlike a public id — so the entropy is the only guarantee there is.
    const ids = new Set(Array.from({ length: 5000 }, () => newSchemaId('field')));
    expect(ids.size).toBe(5000);
  });
});

describe('isSchemaId', () => {
  it('accepts a minted id, optionally checking the kind', () => {
    const id = newSchemaId('entity');
    expect(isSchemaId(id)).toBe(true);
    expect(isSchemaId(id, 'entity')).toBe(true);
    expect(isSchemaId(id, 'field')).toBe(false);
  });

  it('rejects anything that is not one', () => {
    for (const value of ['', 'User', 'ent_', 'ent_XYZ', 'xxx_0123456789ab', 42, null, undefined]) {
      expect(isSchemaId(value)).toBe(false);
    }
  });

  it('rejects an id whose hex is too short to be one of ours', () => {
    // Guards against something like `ent_1` being accepted as identity.
    expect(isSchemaId(`${ID_PREFIX.entity}_abc`)).toBe(false);
  });
});

describe('ensureSchemaIds', () => {
  it('mints an id for every entity, field and relation', () => {
    const doc = ips([
      entity(
        'User',
        [field('email'), field('name')],
        [
          {
            name: 'orders',
            kind: 'hasMany',
            target: 'Order',
            localField: 'id',
            foreignField: 'userId',
            required: false,
            onDelete: 'restrict',
          },
        ],
      ),
      entity('Order', [field('total', 'number')]),
    ]);

    const result = ensureSchemaIds(doc);

    // 2 entities + 3 fields + 1 relation
    expect(result.minted).toBe(6);
    expect(result.unchanged).toBe(false);
    expect(doc.entities[0]?.id).toMatch(/^ent_/);
    expect(doc.entities[0]?.fields[0]?.id).toMatch(/^fld_/);
    expect(doc.entities[0]?.relations?.[0]?.id).toMatch(/^rel_/);
  });

  /**
   * The property the whole migration rests on.
   *
   * `ensurePublicIdentity` is called on a read path, and this backfill will be
   * too — so it runs on every load of every project, forever. If a second run
   * minted anything, the document would churn on every request and every
   * dependency-graph edge would be invalidated behind the user's back.
   */
  it('is idempotent — a second run mints nothing and reports unchanged', () => {
    const doc = ips([entity('User', [field('email')])]);

    ensureSchemaIds(doc);
    const snapshot = JSON.stringify(doc);

    const second = ensureSchemaIds(doc);

    expect(second.minted).toBe(0);
    expect(second.unchanged).toBe(true);
    // Byte-identical: not one id moved.
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('never replaces an id that is already present', () => {
    const doc = ips([entity('User', [{ ...field('email'), id: 'fld_deadbeefcafe' }])]);
    doc.entities[0]!.id = 'ent_0123456789ab';

    ensureSchemaIds(doc);

    expect(doc.entities[0]?.id).toBe('ent_0123456789ab');
    expect(doc.entities[0]?.fields[0]?.id).toBe('fld_deadbeefcafe');
  });

  /**
   * A malformed id is left alone on purpose. Replacing it would break every
   * graph edge pointing at it, which is worse than tolerating an odd string —
   * and rejecting malformed ids is a validator's job, not a backfill's.
   */
  it('leaves a malformed but present id alone', () => {
    const doc = ips([entity('User', [{ ...field('email'), id: 'not-an-id' }])]);
    const result = ensureSchemaIds(doc);

    expect(doc.entities[0]?.fields[0]?.id).toBe('not-an-id');
    // The entity still needed one, so this is 1 rather than 0.
    expect(result.minted).toBe(1);
  });

  it('treats an empty-string id as absent', () => {
    // JSON round-trips and over-eager form handling both produce '' where a
    // field was never set; an empty id is not identity.
    const doc = ips([entity('User', [{ ...field('email'), id: '' }])]);
    ensureSchemaIds(doc);
    expect(doc.entities[0]?.fields[0]?.id).toMatch(/^fld_/);
  });

  it('recurses into nested object children', () => {
    // `customer.address.city` has to be addressable — a field three levels down
    // is as much a graph node as a top-level one.
    const doc = ips([
      entity('Customer', [field('address', 'object', [field('city'), field('postcode')])]),
    ]);

    const result = ensureSchemaIds(doc);

    // 1 entity + address + city + postcode
    expect(result.minted).toBe(4);
    const address = doc.entities[0]?.fields[0];
    expect(address?.children[0]?.id).toMatch(/^fld_/);
    expect(address?.children[1]?.id).toMatch(/^fld_/);
  });

  it('recurses into an array element type', () => {
    // An array's element type lives in children[0], so it is reachable the same
    // way — and it is where meta.reference marks an array-of-reference.
    const doc = ips([entity('Post', [field('tags', 'array', [field('item')])])]);
    ensureSchemaIds(doc);
    expect(doc.entities[0]?.fields[0]?.children[0]?.id).toMatch(/^fld_/);
  });

  it('recurses arbitrarily deep', () => {
    const deep = field('l1', 'object', [
      field('l2', 'object', [field('l3', 'object', [field('l4')])]),
    ]);
    const doc = ips([entity('Deep', [deep])]);
    ensureSchemaIds(doc);

    expect(doc.entities[0]?.fields[0]?.children[0]?.children[0]?.children[0]?.id).toMatch(/^fld_/);
  });

  it('tolerates a document with no entities at all', () => {
    const doc = ips([]);
    expect(ensureSchemaIds(doc)).toEqual({ minted: 0, unchanged: true });
  });

  it('tolerates an entity with no relations key', () => {
    // Every document written before relations existed has none — that is why
    // `relations` is optional on Entity.
    const doc = ips([entity('User', [field('email')])]);
    expect(() => ensureSchemaIds(doc)).not.toThrow();
    expect(doc.entities[0]).not.toHaveProperty('relations');
  });

  it('tolerates missing fields and relations arrays entirely', () => {
    // `ips` is Schema.Types.Mixed, so an old document really can be any shape.
    const ragged = { entities: [{ name: 'Bare' }, {}] } as unknown as Parameters<
      typeof ensureSchemaIds
    >[0];
    expect(() => ensureSchemaIds(ragged)).not.toThrow();
    expect(ragged.entities?.[0]?.id).toMatch(/^ent_/);
  });

  /**
   * Identity is orthogonal to validity. A schema with duplicate names or a
   * dangling relation target still gets ids — refusing to identify a broken
   * schema would make it impossible to describe what is broken about it, which
   * is precisely what impact analysis has to do.
   */
  it('assigns ids to an invalid schema without complaint', () => {
    const doc = ips([
      entity('User', [field('email'), field('email')]),
      entity('User', [field('x', 'string')]),
    ]);
    const result = ensureSchemaIds(doc);
    expect(result.minted).toBe(5);
    expect(duplicateSchemaIds(doc)).toEqual([]);
  });

  it('mints distinct ids for same-named fields on different entities', () => {
    // Name-keying cannot tell these apart; that is the reason ids exist.
    const doc = ips([entity('A', [field('email')]), entity('B', [field('email')])]);
    ensureSchemaIds(doc);
    expect(doc.entities[0]?.fields[0]?.id).not.toBe(doc.entities[1]?.fields[0]?.id);
  });
});

describe('collectSchemaIds', () => {
  it('returns every id in document order', () => {
    const doc = ips([
      entity(
        'User',
        [field('a'), field('b', 'object', [field('c')])],
        [
          {
            name: 'r',
            kind: 'hasMany',
            target: 'X',
            localField: 'id',
            foreignField: 'y',
            required: false,
            onDelete: 'restrict',
          },
        ],
      ),
    ]);
    ensureSchemaIds(doc);

    const ids = collectSchemaIds(doc);
    // entity, a, b, c, relation
    expect(ids).toHaveLength(5);
    expect(ids[0]).toMatch(/^ent_/);
    expect(ids[4]).toMatch(/^rel_/);
  });

  it('skips elements that have no id yet', () => {
    // An un-backfilled document is the normal state, not an error.
    const doc = ips([entity('User', [field('email')])]);
    expect(collectSchemaIds(doc)).toEqual([]);
  });
});

describe('duplicateSchemaIds', () => {
  it('is empty for a freshly backfilled schema', () => {
    const doc = ips([entity('User', [field('a'), field('b')]), entity('Order', [field('c')])]);
    ensureSchemaIds(doc);
    expect(duplicateSchemaIds(doc)).toEqual([]);
  });

  it('reports an id that appears twice', () => {
    // Reachable by a bad copy-paste or a clone-entity feature that forgets to
    // re-mint. A duplicate id is worse than a missing one: two graph nodes
    // become one and impact analysis silently under-reports.
    const doc = ips([
      entity('User', [{ ...field('a'), id: 'fld_aaaaaaaaaaaa' }]),
      entity('Order', [{ ...field('b'), id: 'fld_aaaaaaaaaaaa' }]),
    ]);
    expect(duplicateSchemaIds(doc)).toEqual(['fld_aaaaaaaaaaaa']);
  });

  it('catches a duplicate between a parent and a nested child', () => {
    const doc = ips([
      entity('User', [
        {
          ...field('addr', 'object', [{ ...field('city'), id: 'fld_dupdupdupdup' }]),
          id: 'fld_dupdupdupdup',
        },
      ]),
    ]);
    expect(duplicateSchemaIds(doc)).toEqual(['fld_dupdupdupdup']);
  });
});

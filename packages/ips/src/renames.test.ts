import { describe, it, expect } from 'vitest';

import { ensureSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
import { detectEntityRenames, reconcileEntityRenames } from './renames.js';
import type { InternalProjectSchema } from './types.js';
import { validateIPS } from './validator.js';

/**
 * The bug: renaming an entity that anything relates to could not be saved.
 *
 * `Relation.target` and `FieldMeta.relation` hold entity **names**, so a rename
 * left them naming an entity that no longer existed and `validateIPS` rejected
 * the whole document. Not "saved with stale metadata" — rejected, on both write
 * paths. The pre-existing rename test missed it because it calls
 * `materializeRelations` directly and never validates.
 */

function definition(): InternalProjectSchema {
  const ips: InternalProjectSchema = {
    projectId: 'p1',
    version: 1,
    entities: [
      {
        name: 'Product',
        identity: { field: 'id', style: 'int' },
        fields: [
          {
            name: 'title',
            type: 'string',
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          },
        ],
      },
      {
        name: 'Order',
        identity: { field: 'id', style: 'int' },
        fields: [],
        relations: [
          {
            name: 'product',
            kind: 'belongsTo',
            target: 'Product',
            localField: 'productId',
            foreignField: 'id',
            required: false,
            onDelete: 'restrict',
          },
        ],
      },
    ],
    generationConfig: { validators: [], types: [], methods: ['GET', 'POST'], mockRecords: 3 },
  };
  const materialized = materializeRelations(ips);
  ensureSchemaIds(materialized);
  return materialized;
}

/** What a client sends back: the whole document, with one entity renamed. */
function renameEntity(
  base: InternalProjectSchema,
  from: string,
  to: string,
): InternalProjectSchema {
  const next = JSON.parse(JSON.stringify(base)) as InternalProjectSchema;
  next.entities.find((entity) => entity.name === from)!.name = to;
  return next;
}

/** The save path, in the order the routes run it. */
function save(previous: InternalProjectSchema, next: InternalProjectSchema) {
  const reconciled = reconcileEntityRenames(
    previous,
    next as unknown as Record<string, unknown>,
  ) as unknown as InternalProjectSchema;
  return validateIPS(reconciled);
}

describe('detectEntityRenames', () => {
  it('reports nothing when no name moved', () => {
    const base = definition();
    expect(detectEntityRenames(base, base).size).toBe(0);
  });

  it('keys the rename on the OLD name, which is what stale references hold', () => {
    const base = definition();
    const renames = detectEntityRenames(base, renameEntity(base, 'Product', 'Item'));
    expect([...renames]).toEqual([['Product', 'Item']]);
  });

  it('ignores an entity with no id, because a rename is then indistinguishable from a new entity', () => {
    const base = definition();
    const next = renameEntity(base, 'Product', 'Item');
    delete next.entities.find((entity) => entity.name === 'Item')!.id;

    // Guessing here would rewrite every inbound relation to point at whatever
    // happened to be added, which is worse than leaving the reference alone.
    expect(detectEntityRenames(base, next).size).toBe(0);
  });

  it('does not treat a genuinely new entity as a rename', () => {
    const base = definition();
    const next = JSON.parse(JSON.stringify(base)) as InternalProjectSchema;
    next.entities.push({
      name: 'Invoice',
      identity: { field: 'id', style: 'int' },
      fields: [],
    });
    expect(detectEntityRenames(base, next).size).toBe(0);
  });
});

describe('an entity rename is savable', () => {
  it('follows the rename into relation.target', () => {
    const base = definition();
    const result = save(base, renameEntity(base, 'Product', 'Item'));

    expect(result.ok, JSON.stringify(result.ok ? null : result.error.details)).toBe(true);
    const order = (result.ok ? result.value : base).entities.find((e) => e.name === 'Order')!;
    expect(order.relations?.[0]?.target).toBe('Item');
  });

  it('follows the rename into meta.relation on the derived foreign key', () => {
    const base = definition();
    // `referenceField` stamps `meta.relation` at creation and
    // `materializeRelations` skips the field once it exists, so nothing else
    // would ever correct it — it would keep naming a deleted entity, and the
    // include resolver reads it.
    const before = base.entities
      .find((e) => e.name === 'Order')!
      .fields.find((f) => f.name === 'productId')!;
    expect(before.meta['relation']).toBe('Product');

    const result = save(base, renameEntity(base, 'Product', 'Item'));
    expect(result.ok).toBe(true);

    const after = (result.ok ? result.value : base).entities
      .find((e) => e.name === 'Order')!
      .fields.find((f) => f.name === 'productId')!;
    expect(after.meta['relation']).toBe('Item');
  });

  it('rejected the same edit before the fix', () => {
    // The regression this guards, stated as the failure it used to be.
    const base = definition();
    const unreconciled = validateIPS(renameEntity(base, 'Product', 'Item'));

    expect(unreconciled.ok).toBe(false);
    expect(unreconciled.ok ? [] : unreconciled.error.details).toEqual([
      {
        path: 'entities[1].relations[0].target',
        issue: "Relation target 'Product' is not a declared entity",
      },
    ]);
  });

  it('handles a simultaneous swap without rewriting a reference twice', () => {
    const base = definition();
    const productId = base.entities.find((e) => e.name === 'Product')!.id;
    const orderId = base.entities.find((e) => e.name === 'Order')!.id;

    const next = JSON.parse(JSON.stringify(base)) as InternalProjectSchema;
    // Addressed by id, not by name: after the first assignment two entities are
    // called `Order`, so a name lookup finds the wrong one and renames it back.
    next.entities.find((e) => e.id === productId)!.name = 'Order';
    next.entities.find((e) => e.id === orderId)!.name = 'Product';

    const renames = detectEntityRenames(base, next);
    expect(renames.get('Product')).toBe('Order');
    expect(renames.get('Order')).toBe('Product');

    // The relation targeted Product, so after the swap it must target Order —
    // one hop, not two. Applying the table iteratively would land back on
    // Product and silently self-reference.
    const reconciled = reconcileEntityRenames(
      base,
      next as unknown as Record<string, unknown>,
    ) as unknown as InternalProjectSchema;
    const relating = reconciled.entities.find((e) => e.relations?.length)!;
    expect(relating.relations?.[0]?.target).toBe('Order');
  });
});

describe('reconcileEntityRenames', () => {
  it('returns the input by identity when nothing was renamed', () => {
    // The overwhelmingly common edit must not pay for a deep copy.
    const base = definition();
    const next = JSON.parse(JSON.stringify(base)) as unknown as Record<string, unknown>;
    expect(reconcileEntityRenames(base, next)).toBe(next);
  });

  it('leaves a malformed document untouched for validateIPS to reject properly', () => {
    // It runs on unvalidated client input, so throwing here would turn a 422
    // with a usable path into a 500.
    const base = definition();
    expect(() =>
      reconcileEntityRenames(base, { entities: 'not an array' } as Record<string, unknown>),
    ).not.toThrow();
    expect(() => reconcileEntityRenames(base, {} as Record<string, unknown>)).not.toThrow();
    expect(() =>
      reconcileEntityRenames(base, { entities: [null, 7, { fields: 'nope' }] } as Record<
        string,
        unknown
      >),
    ).not.toThrow();
  });

  it('follows a rename into a nested field meta', () => {
    const base = definition();
    const next = renameEntity(base, 'Product', 'Item');
    const order = next.entities.find((entity) => entity.name === 'Order')!;
    order.fields.push({
      name: 'shipping',
      type: 'object',
      required: false,
      default: null,
      validation: {},
      meta: {},
      children: [
        {
          name: 'productRef',
          type: 'integer',
          required: false,
          default: null,
          children: [],
          validation: {},
          meta: { relation: 'Product' },
        },
      ],
    });

    const reconciled = reconcileEntityRenames(
      base,
      next as unknown as Record<string, unknown>,
    ) as unknown as InternalProjectSchema;

    const nested = reconciled.entities
      .find((entity) => entity.name === 'Order')!
      .fields.find((field) => field.name === 'shipping')!.children[0]!;
    expect(nested.meta['relation']).toBe('Item');
  });
});

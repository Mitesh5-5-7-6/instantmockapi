/**
 * End-to-end validation of the pure edit pipeline.
 *
 * One realistic project, one realistic edit session, walked through every stage
 * the way the API routes will: materialize → backfill → fork a draft → edit →
 * diff → build the graph → analyse impact → decide what to regenerate.
 *
 * The unit tests around each stage assert its rules. This file asserts that the
 * stages compose — that the strings a user would read in the regeneration dialog
 * are the strings this pipeline actually produces, for an edit with several
 * changes of different risks landing on overlapping endpoint sets.
 *
 * What is NOT covered here, stated so the coverage is not overread: committing
 * the draft, creating a version, enqueuing generation, and promoting the runtime.
 * Those need the draft routes and the commit endpoint, and they are the next
 * items in the sequence. Everything up to "here is what will be regenerated" is.
 */

import { describe, it, expect } from 'vitest';

import { diffSchemas, needsAttention, summariseChanges } from './changes.js';
import { buildDependencyGraph } from './graph.js';
import { ensureSchemaIds } from './ids.js';
import { analyseDraftImpact } from './impact.js';
import { materializeRelations } from './relations.js';
import { reconcileEntityRenames } from './renames.js';
import { validateIPS } from './validator.js';
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

/** A small e-commerce project, the kind the wizard actually produces. */
function shopIps(): InternalProjectSchema {
  const product: Entity = {
    name: 'Product',
    identity: { field: 'id', style: 'int' },
    fields: [
      field('title', { required: true }),
      field('price', { type: 'integer' }),
      field('status', {
        type: 'enum',
        required: true,
        validation: { enum: ['draft', 'active', 'archived'] },
      }),
      field('description'),
    ],
  };
  const order: Entity = {
    name: 'Order',
    identity: { field: 'id', style: 'uuid' },
    fields: [field('total', { type: 'integer', required: true })],
    relations: [{ name: 'product', kind: 'belongsTo', target: 'Product', localField: 'productId' }],
  };

  return {
    projectId: 'shop',
    version: 3,
    entities: [product, order],
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 25,
      features: { search: true, filter: true, sort: true, include: true },
    },
  } as InternalProjectSchema;
}

/** Stage 1–2: what the project looks like once stored. */
function activeDefinition(): InternalProjectSchema {
  const active = materializeRelations(shopIps());
  ensureSchemaIds(active);
  return active;
}

/** Stage 3: fork a draft, exactly as `POST /projects/:id/draft` will. */
function forkDraft(active: InternalProjectSchema): InternalProjectSchema {
  return JSON.parse(JSON.stringify(active)) as InternalProjectSchema;
}

/**
 * Stage 4: what `PATCH /projects/:id/draft` does after applying an edit.
 *
 * The `previous` argument and the `validateIPS` call are both load-bearing, and
 * their absence hid a real bug: this helper used to materialize and backfill
 * only, which is *not* what the route does. The route reconciles renames first
 * and validates in the middle — and validation is what rejects a
 * `relation.target` naming an entity that was just renamed. So "renaming an
 * entity broke saving entirely" passed through here unnoticed. If this helper
 * ever drifts from `applyDraftEdit` again, the same class of bug comes back.
 */
function saveDraft(
  draft: InternalProjectSchema,
  previous: InternalProjectSchema = draft,
): InternalProjectSchema {
  const reconciled = reconcileEntityRenames(
    previous,
    draft as unknown as Record<string, unknown>,
  ) as unknown as InternalProjectSchema;
  const validated = validateIPS(reconciled);
  if (!validated.ok) {
    throw new Error(
      `saveDraft produced an invalid definition: ${JSON.stringify(validated.error.details)}`,
    );
  }
  const saved = materializeRelations(validated.value);
  ensureSchemaIds(saved);
  return saved;
}

const label = (endpoint: { method: string; path: string }): string =>
  `${endpoint.method} ${endpoint.path}`;

describe('a realistic edit session', () => {
  /**
   * Four edits at once, which is what a real session looks like:
   *
   * 1. `Product` gets a description                    → INFO,     nothing
   * 2. `Product.slug` added, optional                  → SAFE,     reads + writes
   * 3. `Product.price` becomes required                → WARNING,  writes only
   * 4. `Order.total` changes integer → string          → BREAKING, both ways
   */
  function editedDraft(): { active: InternalProjectSchema; draft: InternalProjectSchema } {
    const active = activeDefinition();
    const draft = forkDraft(active);

    const product = draft.entities.find((e) => e.name === 'Product')!;
    product.description = 'Things the shop sells';
    product.fields.push(field('slug'));
    product.fields.find((f) => f.name === 'price')!.required = true;

    const order = draft.entities.find((e) => e.name === 'Order')!;
    order.fields.find((f) => f.name === 'total')!.type = 'string';

    return { active, draft: saveDraft(draft) };
  }

  it('produces a draft that is still a valid project definition', () => {
    // A draft the user cannot commit is worse than a rejected edit. Validation
    // runs on save, before any of the analysis below is worth computing.
    const { draft } = editedDraft();
    expect(validateIPS(draft).ok).toBe(true);
  });

  it('reports exactly the four changes, at the four risks', () => {
    const { active, draft } = editedDraft();
    const changes = diffSchemas(active, draft);

    expect(changes.map((c) => c.kind).sort()).toEqual([
      'ENTITY_DESCRIPTION_CHANGED',
      'FIELD_ADDED',
      'FIELD_REQUIRED_CHANGED',
      'FIELD_TYPE_CHANGED',
    ]);
    expect(summariseChanges(changes)).toEqual({
      INFO: 1,
      SAFE: 1,
      WARNING: 1,
      ROUTING: 0,
      BREAKING: 1,
    });
    expect(needsAttention(changes)).toBe(true);
  });

  /**
   * The regeneration dialog's two lists. Every endpoint in the project appears in
   * exactly one of them — that completeness is what makes "not affected" a claim
   * rather than an omission.
   */
  it('splits the whole endpoint surface into affected and not-affected', () => {
    const { active, draft } = editedDraft();
    const report = analyseDraftImpact(active, draft);

    expect(report.affected.map(label).sort()).toEqual([
      'GET /order',
      'GET /order/{id}',
      'GET /product',
      'GET /product/{id}',
      'PATCH /order/{id}',
      'PATCH /product/{id}',
      'POST /order',
      'POST /product',
      'PUT /order/{id}',
      'PUT /product/{id}',
    ]);

    // The requirement, holding across a four-change session on two entities:
    // neither DELETE is touched, because no edit crossed a DELETE wire.
    expect(report.unaffected.map(label).sort()).toEqual([
      'DELETE /order/{id}',
      'DELETE /product/{id}',
      'GET /',
    ]);

    const graph = buildDependencyGraph(draft);
    const total = [...graph.nodes.values()].filter((n) => n.kind === 'endpoint').length;
    expect(report.affected.length + report.unaffected.length).toBe(total);
    expect(report.risk).toBe('BREAKING');
  });

  /** The per-endpoint "Why is this affected?" tree, verbatim. */
  it('explains each affected endpoint with a precise pointer', () => {
    const { active, draft } = editedDraft();
    const report = analyseDraftImpact(active, draft);
    const explain = (endpoint: string): string[] =>
      report.affected
        .find((e) => label(e) === endpoint)!
        .reasons.map((r) => `${r.source} → ${r.reason}`)
        .sort();

    // A required-field change and an added field, both write-side; the added
    // field also appears in the echoed response.
    expect(explain('POST /product')).toEqual([
      'Product.price → request.body.price',
      'Product.slug → request.body.slug',
      'Product.slug → response.Product.slug',
    ]);

    // The item GET takes no body, so only the added field reaches it — the
    // requiredness change does not.
    expect(explain('GET /product/{id}')).toEqual(['Product.slug → response.Product.slug']);

    // A type change moves in both directions, and drops out of the query layer
    // in the same edit, so its filter and sort pointers are gone from the draft.
    expect(explain('PATCH /order/{id}')).toEqual([
      'Order.total → request.body.total',
      'Order.total → response.Order.total',
    ]);
  });

  it('carries the risk of the worst change reaching each endpoint', () => {
    const { active, draft } = editedDraft();
    const byEndpoint = new Map(
      analyseDraftImpact(active, draft).affected.map((e) => [label(e), e.risk]),
    );

    // Order.total is BREAKING and reaches every Order read and write.
    expect(byEndpoint.get('POST /order')).toBe('BREAKING');
    expect(byEndpoint.get('GET /order')).toBe('BREAKING');
    // Product is touched only by the SAFE add and the WARNING requiredness.
    expect(byEndpoint.get('POST /product')).toBe('WARNING');
    // The Product item GET sees only the SAFE added field.
    expect(byEndpoint.get('GET /product/{id}')).toBe('SAFE');
  });

  /**
   * The dialog's per-artifact checkboxes. A conservative superset by design:
   * regenerating an artifact that did not need it costs seconds, while skipping
   * one that did leaves a live API disagreeing with its own documentation.
   */
  it('names the artifacts to regenerate, and nothing outside the registry', () => {
    const { active, draft } = editedDraft();
    const report = analyseDraftImpact(active, draft);

    expect(report.artifacts).toEqual([
      'export_zip',
      'hosted_api',
      'json_schema',
      'mock_data',
      'openapi',
      'postman',
      'typescript',
      'yup',
      'zod',
    ]);
  });

  it('reports the analysis as complete, having matched every change to a node', () => {
    const { active, draft } = editedDraft();
    const report = analyseDraftImpact(active, draft);

    expect(report.incomplete).toBe(false);
    // Only the description edit reached no wire, and that is expected, not a gap.
    expect(report.unattributed).toEqual([
      { change: expect.objectContaining({ kind: 'ENTITY_DESCRIPTION_CHANGED' }), cause: 'no-wire' },
    ]);
  });
});

describe('the identity invariant across the session', () => {
  /**
   * The property the whole design rests on: a rename is one element changing.
   *
   * Renaming an entity and a field at once must produce two rename changes and
   * zero add/remove pairs. If ids were not stable through
   * `materializeRelations` and the JSON round trip, this would report four
   * changes — a delete and a create for each — and the impact report would claim
   * a routine rename destroyed and rebuilt half the API.
   */
  it('sees a rename as a rename, not a delete plus a create', () => {
    const active = activeDefinition();
    const draft = forkDraft(active);

    draft.entities.find((e) => e.name === 'Product')!.name = 'Item';
    draft.entities.find((e) => e.name === 'Item')!.fields.find((f) => f.name === 'title')!.name =
      'name';

    // `active` as the previous side, so the rename is detectable — and this
    // saves at all only because `Order.product` now follows `Product → Item`.
    const changes = diffSchemas(active, saveDraft(draft, active));

    // The two renames are the news. Nothing is reported as added or removed,
    // which is the property stable ids exist to give.
    expect(changes.some((c) => c.kind.endsWith('_ADDED'))).toBe(false);
    expect(changes.some((c) => c.kind.endsWith('_REMOVED'))).toBe(false);
    expect(changes.filter((c) => c.kind.endsWith('_RENAMED')).map((c) => c.kind)).toEqual([
      'ENTITY_RENAMED',
      'FIELD_RENAMED',
    ]);

    // The rest is the cascade: `Order.product`'s target and `Order.productId`'s
    // `meta.relation` both spell the entity by name, so both moved. They are
    // reported — a diff that omitted them would not explain the byte difference
    // between the two definitions — but at INFO with no aspect, so they cannot
    // reach an endpoint or raise the report's risk.
    const echoes = changes.filter((c) => !c.kind.endsWith('_RENAMED'));
    expect(echoes.map((c) => c.kind).sort()).toEqual([
      'FIELD_META_CHANGED',
      'RELATION_TARGET_CHANGED',
    ]);
    expect(echoes.every((c) => c.risk === 'INFO' && c.aspect === 'none')).toBe(true);
  });

  /**
   * The demotion has to be narrow, or it becomes a way to smuggle a real change
   * past the review gate: rename an entity in the same edit as tightening a
   * field, and the tightening rides along at INFO.
   */
  it('does not demote a real metadata change that happens alongside a rename', () => {
    const active = activeDefinition();
    const draft = forkDraft(active);
    draft.entities.find((e) => e.name === 'Product')!.name = 'Item';
    const fk = draft.entities
      .find((e) => e.name === 'Order')!
      .fields.find((f) => f.name === 'productId')!;
    fk.meta = { ...fk.meta, unique: true };

    const changes = diffSchemas(active, saveDraft(draft, active));
    const meta = changes.find((c) => c.kind === 'FIELD_META_CHANGED')!;

    // `meta.relation` followed the rename AND `unique` was set. The second is
    // real, so the row keeps its own risk rather than being written off.
    expect(meta.risk).toBe('SAFE');
    expect(meta.aspect).toBe('write');
  });

  it('does not demote a genuine retarget to a different entity', () => {
    const active = activeDefinition();
    const draft = forkDraft(active);
    // No rename at all — the relation is repointed at a real other entity.
    draft.entities.find((e) => e.name === 'Order')!.relations![0]!.target = 'Order';

    const retarget = diffSchemas(active, saveDraft(draft, active)).find(
      (c) => c.kind === 'RELATION_TARGET_CHANGED',
    )!;
    expect(retarget.risk).toBe('BREAKING');
    expect(retarget.aspect).toBe('both');
  });

  /**
   * The rename above is only two changes because the cascade is silent.
   *
   * `Order.product` targeted `Product` and now targets `Item`, and its derived
   * `productId` field's `meta.relation` moved with it. Neither shows up as a
   * change — `diffRelations` does not compare targets that were reconciled, and
   * `FIELD_META_CHANGED` is not emitted for the follow. That is the intended
   * shape for Phase 1; Phase 2 surfaces the cascade at INFO beneath the rename
   * rather than as breaking peers, and this test pins where it starts from.
   */
  it('carries inbound relations to the new entity name', () => {
    const active = activeDefinition();
    const draft = forkDraft(active);
    draft.entities.find((e) => e.name === 'Product')!.name = 'Item';

    const saved = saveDraft(draft, active);
    const order = saved.entities.find((e) => e.name === 'Order')!;

    expect(order.relations?.[0]?.target).toBe('Item');
    expect(order.fields.find((f) => f.name === 'productId')?.meta['relation']).toBe('Item');
  });

  it('keeps every schema id byte-identical through save', () => {
    const active = activeDefinition();
    const before = JSON.stringify(active.entities.map((e) => [e.id, e.fields.map((f) => f.id)]));

    const saved = saveDraft(forkDraft(active));
    const after = JSON.stringify(saved.entities.map((e) => [e.id, e.fields.map((f) => f.id)]));

    expect(after).toBe(before);
  });

  it('mints no new ids on a second save of an unchanged draft', () => {
    const active = activeDefinition();
    const once = saveDraft(forkDraft(active));
    const twice = saveDraft(JSON.parse(JSON.stringify(once)) as InternalProjectSchema);

    expect(diffSchemas(once, twice)).toEqual([]);
    expect(analyseDraftImpact(once, twice).affected).toEqual([]);
  });

  /**
   * The routing consequence of a rename, which is currently unavoidable:
   * `ENTITY_PATH` is `entity.name.toLowerCase()`, so internal identity and public
   * URL are the same string. The report says so rather than hiding it — every URL
   * moves, and DELETE moves with them even though its payload is untouched.
   */
  it('moves every URL when an entity is renamed, DELETE included', () => {
    const active = activeDefinition();
    const draft = forkDraft(active);
    draft.entities.find((e) => e.name === 'Product')!.name = 'Item';

    const report = analyseDraftImpact(active, saveDraft(draft, active));
    expect(report.risk).toBe('ROUTING');
    expect(report.affected.map(label).sort()).toEqual([
      'DELETE /item/{id}',
      'GET /',
      'GET /item',
      'GET /item/{id}',
      'PATCH /item/{id}',
      'POST /item',
      'PUT /item/{id}',
    ]);
    // The Order endpoints are genuinely untouched by a Product rename.
    expect(report.unaffected.map(label).sort()).toEqual([
      'DELETE /order/{id}',
      'GET /order',
      'GET /order/{id}',
      'PATCH /order/{id}',
      'POST /order',
      'PUT /order/{id}',
    ]);
  });
});

describe('a no-op session', () => {
  it('costs nothing and asks for nothing', () => {
    const active = activeDefinition();
    const report = analyseDraftImpact(active, saveDraft(forkDraft(active)));

    expect(report.changes).toEqual([]);
    expect(report.affected).toEqual([]);
    expect(report.artifacts).toEqual([]);
    expect(report.risk).toBeNull();
    expect(report.incomplete).toBe(false);
    // Thirteen endpoints across two entities plus the catalogue, all confirmed.
    expect(report.unaffected).toHaveLength(13);
  });
});

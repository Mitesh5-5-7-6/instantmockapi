import { describe, it, expect } from 'vitest';
import { goldenRelationsIPS } from '../__tests__/golden-relations-fixture.js';
import { materializeRelations } from './relations.js';
import {
  ALL_QUERY_FEATURES,
  NO_QUERY_FEATURES,
  QUERY_FEATURES,
  RESERVED_QUERY_KEYS,
  enabledQueryFeatures,
  entityQueryFields,
  hasQueryFeatures,
  includableRelations,
  queryFeatures,
  queryableFields,
  resolveQueryFeatures,
  searchableFields,
} from './query.js';
import type { Entity, Field, FieldType } from './types.js';

function field(name: string, type: FieldType = 'string', meta: Field['meta'] = {}): Field {
  return { name, type, required: false, default: null, children: [], validation: {}, meta };
}

const entity: Entity = {
  name: 'Product',
  fields: [
    field('id', 'uuid'),
    field('title'),
    field('price', 'decimal'),
    field('inStock', 'boolean'),
    field('releasedAt', 'date'),
    field('tier', 'enum'),
    { ...field('dimensions', 'object'), children: [field('width', 'number')] },
    { ...field('tags', 'array'), children: [field('tag')] },
  ],
};

describe('resolveQueryFeatures — what an absent toggle block means', () => {
  it('resolves missing input to every feature off', () => {
    // The load-bearing default: already-hosted projects carry no toggles and
    // must keep behaving as they did before the query layer existed.
    expect(resolveQueryFeatures(undefined)).toEqual(NO_QUERY_FEATURES);
    expect(resolveQueryFeatures(null)).toEqual(NO_QUERY_FEATURES);
  });

  it('resolves non-object input to every feature off rather than throwing', () => {
    for (const junk of ['search', 42, true, ['search'], () => true]) {
      expect(resolveQueryFeatures(junk)).toEqual(NO_QUERY_FEATURES);
    }
  });

  it('completes a partial block, defaulting the unmentioned toggles off', () => {
    expect(resolveQueryFeatures({ search: true })).toEqual({
      search: true,
      filter: false,
      sort: false,
      include: false,
    });
  });

  it('treats only a literal true as on — truthy values do not enable a feature', () => {
    // Guards against a form post sending features[sort]="false", which is a
    // non-empty string and would enable sorting under a truthiness check.
    expect(resolveQueryFeatures({ search: 'false', filter: 1, sort: 'true', include: {} })).toEqual(
      NO_QUERY_FEATURES,
    );
  });

  it('ignores unknown keys instead of carrying them through', () => {
    const resolved = resolveQueryFeatures({ search: true, paginate: true });
    expect(Object.keys(resolved).sort()).toEqual([...QUERY_FEATURES].sort());
  });

  it('returns a fresh object, so a caller cannot mutate the shared default', () => {
    const first = resolveQueryFeatures(undefined);
    first.search = true;
    expect(resolveQueryFeatures(undefined).search).toBe(false);
    expect(NO_QUERY_FEATURES.search).toBe(false);
  });

  it('reads the toggles off a generation config', () => {
    expect(queryFeatures({ features: { ...ALL_QUERY_FEATURES } })).toEqual(ALL_QUERY_FEATURES);
    expect(queryFeatures({})).toEqual(NO_QUERY_FEATURES);
    expect(queryFeatures(undefined)).toEqual(NO_QUERY_FEATURES);
  });

  it('reports which features are on, in declaration order', () => {
    expect(hasQueryFeatures(NO_QUERY_FEATURES)).toBe(false);
    expect(hasQueryFeatures({ ...NO_QUERY_FEATURES, sort: true })).toBe(true);
    expect(enabledQueryFeatures(NO_QUERY_FEATURES)).toEqual([]);
    expect(
      enabledQueryFeatures({ search: false, filter: true, sort: false, include: true }),
    ).toEqual(['filter', 'include']);
  });
});

describe('field selection', () => {
  it('makes every top-level scalar filterable and sortable', () => {
    expect(queryableFields(entity)).toEqual([
      'id',
      'title',
      'price',
      'inStock',
      'releasedAt',
      'tier',
    ]);
  });

  it('excludes object and array fields — and does not reach into their children', () => {
    const queryable = queryableFields(entity);
    expect(queryable).not.toContain('dimensions');
    expect(queryable).not.toContain('tags');
    // Nested leaves are out of scope: no dimensions.width path support.
    expect(queryable).not.toContain('width');
    expect(queryable).not.toContain('dimensions.width');
  });

  it('defaults search to textual fields only', () => {
    // A term would match coincidentally against timestamps and numbers, so the
    // implicit default stays on fields a human would actually search.
    expect(searchableFields(entity)).toEqual(['id', 'title', 'tier']);
  });

  it('treats any explicit meta.searchable as the whole whitelist', () => {
    const marked: Entity = {
      ...entity,
      fields: entity.fields.map((f) =>
        f.name === 'title' ? { ...f, meta: { searchable: true } } : f,
      ),
    };
    expect(searchableFields(marked)).toEqual(['title']);
  });

  it('honours an explicit opt-in on a non-textual scalar', () => {
    // Search compares the string form of a value, which is well defined for a
    // number — so an explicit opt-in is respected rather than filtered out.
    const marked: Entity = {
      ...entity,
      fields: entity.fields.map((f) =>
        f.name === 'price' ? { ...f, meta: { searchable: true } } : f,
      ),
    };
    expect(searchableFields(marked)).toEqual(['price']);
  });

  it('never offers an object or array field for search, even when marked', () => {
    const marked: Entity = {
      ...entity,
      fields: entity.fields.map((f) =>
        f.name === 'tags' ? { ...f, meta: { searchable: true } } : f,
      ),
    };
    // The opt-in is ignored, and the textual default applies instead.
    expect(searchableFields(marked)).toEqual(['id', 'title', 'tier']);
  });

  it('tolerates entities written without fields or relations', () => {
    const bare = { name: 'Empty' } as unknown as Entity;
    expect(queryableFields(bare)).toEqual([]);
    expect(searchableFields(bare)).toEqual([]);
    expect(includableRelations(bare)).toEqual([]);
  });

  it('lists relation names as the includable set', () => {
    const materialized = materializeRelations(goldenRelationsIPS);
    const student = materialized.entities.find((e) => e.name === 'Student')!;
    expect(includableRelations(student)).toEqual(['classroom', 'courses']);
  });

  it('exposes the derived foreign key as filterable once relations materialize', () => {
    // ?classroomId=3 is the natural way to fetch one classroom's students, and
    // it only works because materialization put a real field there.
    const materialized = materializeRelations(goldenRelationsIPS);
    const student = materialized.entities.find((e) => e.name === 'Student')!;
    expect(queryableFields(student)).toContain('classroomId');
  });

  it('does not offer the many-to-many key array for filtering', () => {
    const materialized = materializeRelations(goldenRelationsIPS);
    const student = materialized.entities.find((e) => e.name === 'Student')!;
    // courseIds is an array field — excluded like any other array.
    expect(queryableFields(student)).not.toContain('courseIds');
  });
});

describe('entityQueryFields', () => {
  it('bundles all four lists from one derivation', () => {
    const materialized = materializeRelations(goldenRelationsIPS);
    const student = materialized.entities.find((e) => e.name === 'Student')!;
    const fields = entityQueryFields(student);
    expect(fields.filterable).toEqual(queryableFields(student));
    expect(fields.sortable).toEqual(queryableFields(student));
    expect(fields.searchable).toEqual(searchableFields(student));
    expect(fields.includable).toEqual(['classroom', 'courses']);
  });

  it('gives sortable its own array, so mutating one list cannot corrupt the other', () => {
    const fields = entityQueryFields(entity);
    fields.sortable.push('injected');
    expect(fields.filterable).not.toContain('injected');
  });
});

describe('reserved query keys', () => {
  it('reserves exactly the parameters the runtime interprets', () => {
    // Reserving a key we do not implement would turn a typo into a silently
    // ignored parameter — the failure the unknown-key rejection prevents.
    expect([...RESERVED_QUERY_KEYS].sort()).toEqual(
      ['include', 'limit', 'page', 'search', 'sort'].sort(),
    );
  });
});

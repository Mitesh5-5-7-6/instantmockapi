import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import { ALL_QUERY_FEATURES, NO_QUERY_FEATURES, type EntityQueryFields } from '@instantmockapi/ips';
import {
  compareValues,
  expandIncludes,
  looseEquals,
  paginate,
  parseQuery,
  selectRecords,
  sortRecords,
  type IncludeTarget,
  type QueryPlan,
} from './query.js';
import type { MockRecord } from './store.js';

const env = loadEnvConfig();

const fields: EntityQueryFields = {
  searchable: ['name', 'city'],
  filterable: ['id', 'name', 'city', 'age', 'active', 'joinedAt', 'score'],
  sortable: ['id', 'name', 'city', 'age', 'active', 'joinedAt', 'score'],
  includable: ['orders', 'company'],
};

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return { page: 1, limit: 20, search: null, filters: [], sort: [], includes: [], ...overrides };
}

/** Parse with everything switched on, which is the interesting case. */
function parse(query: Record<string, string | string[]>): QueryPlan {
  return parseQuery(query, fields, { ...ALL_QUERY_FEATURES }, env);
}

function expectBadQuery(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.statusCode).toBe(400);
    return appError;
  }
  throw new Error('expected the query to be rejected');
}

describe('parseQuery — pagination', () => {
  it('keeps the pre-existing defaults and clamping exactly', () => {
    expect(parse({})).toMatchObject({ page: 1, limit: 20 });
    expect(parse({ page: '3', limit: '5' })).toMatchObject({ page: 3, limit: 5 });
    // Garbage and out-of-range values fall back rather than erroring, which is
    // how this behaved before the query layer and what the runtime tests pin.
    expect(parse({ page: 'abc' }).page).toBe(1);
    expect(parse({ page: '0' }).page).toBe(1);
    expect(parse({ page: '-4' }).page).toBe(1);
    expect(parse({ limit: '0' }).limit).toBe(20);
    expect(parse({ limit: '99999' }).limit).toBe(env.maxPaginationLimit);
  });

  it('is not a feature, so it works with every toggle off', () => {
    // Pagination bounds the response size; it is not something a project can
    // switch off, so it must parse under all-off features.
    const parsed = parseQuery({ page: '2', limit: '7' }, fields, { ...NO_QUERY_FEATURES }, env);
    expect(parsed).toMatchObject({ page: 2, limit: 7 });
  });
});

describe('parseQuery — disabled features', () => {
  it('rejects a reserved parameter whose feature is off, naming the toggle', () => {
    for (const [key, toggle] of [
      ['search', 'search'],
      ['sort', 'sorting'],
      ['include', 'relations'],
    ] as const) {
      const error = expectBadQuery(() =>
        parseQuery({ [key]: 'anything' }, fields, { ...NO_QUERY_FEATURES }, env),
      );
      expect(error.message).toContain(`'${key}'`);
      expect(error.message).toContain(toggle);
    }
  });

  it('ignores an unrecognised key when filtering is off, rather than rejecting it', () => {
    // A tracking parameter cannot be told apart from a mistyped filter, so with
    // the feature off neither is treated as an error.
    const parsed = parseQuery(
      { utm_source: 'newsletter', nonsense: 'x' },
      fields,
      { ...NO_QUERY_FEATURES },
      env,
    );
    expect(parsed.filters).toEqual([]);
  });

  it('ignores unknown keys even when filtering is on for other reasons', () => {
    // Sanity: with filter on, the same keys DO become errors — this is the
    // asymmetry the module documents.
    expectBadQuery(() => parse({ utm_source: 'newsletter' }));
  });
});

describe('parseQuery — repeated parameters', () => {
  it('rejects a repeated filter and points at the _in operator', () => {
    const error = expectBadQuery(() => parse({ city: ['Paris', 'Berlin'] }));
    expect(error.message).toContain('city_in=a,b');
  });

  it('rejects a repeated reserved parameter too', () => {
    expectBadQuery(() => parse({ sort: ['name', '-age'] }));
    expectBadQuery(() => parse({ page: ['1', '2'] }));
  });
});

describe('parseQuery — filters', () => {
  it('reads a bare field name as equality', () => {
    expect(parse({ city: 'Paris' }).filters).toEqual([
      { field: 'city', operator: 'eq', value: 'Paris', values: [] },
    ]);
  });

  it('splits a trailing operator suffix off the field name', () => {
    expect(parse({ age_gte: '30' }).filters).toEqual([
      { field: 'age', operator: 'gte', value: '30', values: [] },
    ]);
    expect(parse({ name_like: 'ada' }).filters[0]).toMatchObject({
      field: 'name',
      operator: 'like',
    });
  });

  it('splits _in into trimmed values', () => {
    expect(parse({ city_in: 'Paris, Berlin ,Oslo' }).filters[0]).toMatchObject({
      field: 'city',
      operator: 'in',
      values: ['Paris', 'Berlin', 'Oslo'],
    });
  });

  it('prefers an exact field name over an operator reading of the same key', () => {
    // An entity with a field literally called `score_lt` stays filterable by its
    // own name instead of being reinterpreted as `score` < value.
    const shadowed: EntityQueryFields = {
      ...fields,
      filterable: [...fields.filterable, 'score_lt'],
    };
    const parsed = parseQuery({ score_lt: '5' }, shadowed, { ...ALL_QUERY_FEATURES }, env);
    expect(parsed.filters).toEqual([{ field: 'score_lt', operator: 'eq', value: '5', values: [] }]);
  });

  it('rejects an unknown filter field and lists what is filterable', () => {
    const error = expectBadQuery(() => parse({ ctiy: 'Paris' }));
    expect(error.message).toContain("'ctiy'");
    expect(error.details?.[0]?.issue).toContain('city');
  });

  it('reports every unknown filter at once, not just the first', () => {
    const error = expectBadQuery(() => parse({ ctiy: 'Paris', nmae: 'Ada' }));
    expect(error.details).toHaveLength(2);
    expect(error.details?.map((d) => d.path).sort()).toEqual(['ctiy', 'nmae']);
  });

  it('rejects an unknown operator on a known field', () => {
    // `age_between` is not an operator, and `age_between` is not a field.
    expectBadQuery(() => parse({ age_between: '1,2' }));
  });

  it('never treats a reserved key as a filter, even when a field shares its name', () => {
    // The documented collision: a field called `page` is not filterable, because
    // `?page=2` has to keep paginating.
    const collides: EntityQueryFields = { ...fields, filterable: [...fields.filterable, 'page'] };
    const parsed = parseQuery({ page: '2' }, collides, { ...ALL_QUERY_FEATURES }, env);
    expect(parsed.page).toBe(2);
    expect(parsed.filters).toEqual([]);
  });
});

describe('parseQuery — sort', () => {
  it('reads a leading minus as descending and splits on commas', () => {
    expect(parse({ sort: 'city,-age' }).sort).toEqual([
      { field: 'city', direction: 1 },
      { field: 'age', direction: -1 },
    ]);
  });

  it('tolerates whitespace and empty segments', () => {
    expect(parse({ sort: ' name , , -age ' }).sort).toEqual([
      { field: 'name', direction: 1 },
      { field: 'age', direction: -1 },
    ]);
  });

  it('rejects an unsortable field and explains the minus prefix', () => {
    const error = expectBadQuery(() => parse({ sort: 'unknown' }));
    expect(error.message).toContain('unknown');
    expect(error.message).toContain('name');
  });
});

describe('parseQuery — include', () => {
  it('splits, trims and de-duplicates relation names', () => {
    expect(parse({ include: 'orders, company ,orders' }).includes).toEqual(['orders', 'company']);
  });

  it('rejects an unknown relation and lists the includable ones', () => {
    const error = expectBadQuery(() => parse({ include: 'invoices' }));
    expect(error.message).toContain('invoices');
    expect(error.message).toContain('orders');
  });

  it('rejects a nested include with its own message', () => {
    // Someone writing this understood the parameter and guessed at its depth.
    const error = expectBadQuery(() => parse({ include: 'company.address' }));
    expect(error.message).toContain('Nested includes are not supported');
    expect(error.message).toContain("'?include=company'");
  });

  it('reports "none" rather than an empty list when nothing is includable', () => {
    const error = expectBadQuery(() =>
      parseQuery({ include: 'orders' }, { ...fields, includable: [] }, ALL_QUERY_FEATURES, env),
    );
    expect(error.message).toContain('none');
  });
});

describe('parseQuery — a config predating the query layer', () => {
  it('rejects any query field when the entity carries no lists', () => {
    // Features on but no field lists: nothing is queryable, and every attempt
    // gets a 400 listing "none" instead of silently matching everything.
    const error = expectBadQuery(() =>
      parseQuery({ city: 'Paris' }, undefined, { ...ALL_QUERY_FEATURES }, env),
    );
    expect(error.details?.[0]?.issue).toContain('none');
  });

  it('still paginates', () => {
    expect(parseQuery({ page: '2' }, undefined, { ...NO_QUERY_FEATURES }, env).page).toBe(2);
  });
});

describe('compareValues', () => {
  it('orders numbers numerically even when they arrive as text', () => {
    // The bug this prevents: lexicographic ordering putting 9 after 10.
    expect(compareValues(9, 10)).toBeLessThan(0);
    expect(compareValues('9', '10')).toBeLessThan(0);
    expect(compareValues('9', 10)).toBeLessThan(0);
    expect(compareValues(2.5, 2.25)).toBeGreaterThan(0);
  });

  it('orders booleans false before true, including their string forms', () => {
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(true, 'false')).toBeGreaterThan(0);
  });

  it('orders ISO dates by instant', () => {
    expect(compareValues('2024-01-02', '2024-01-10')).toBeLessThan(0);
    expect(compareValues('2024-03-01T10:00:00Z', '2024-03-01T09:00:00Z')).toBeGreaterThan(0);
  });

  it('groups strings case-insensitively but stays a total order', () => {
    // `apple` and `Apple` sort adjacently; the raw tiebreak keeps the result
    // reproducible instead of depending on input order.
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
    expect(compareValues('Apple', 'apple')).not.toBe(0);
    expect(Math.sign(compareValues('Apple', 'apple'))).toBe(
      -Math.sign(compareValues('apple', 'Apple')),
    );
  });

  it('is antisymmetric on equal values', () => {
    expect(compareValues('same', 'same')).toBe(0);
    expect(compareValues(5, 5)).toBe(0);
  });
});

describe('looseEquals', () => {
  it('ignores representation but respects case', () => {
    expect(looseEquals(30, '30')).toBe(true);
    expect(looseEquals('30', '30')).toBe(true);
    expect(looseEquals(true, 'true')).toBe(true);
    expect(looseEquals(false, 'true')).toBe(false);
    // Case-insensitive matching belongs to `_like`, so equality stays exact.
    expect(looseEquals('Ada', 'ada')).toBe(false);
  });

  it('matches the literal null against a missing value', () => {
    expect(looseEquals(null, 'null')).toBe(true);
    expect(looseEquals(undefined, 'null')).toBe(true);
    expect(looseEquals('', 'null')).toBe(false);
    expect(looseEquals(null, 'anything')).toBe(false);
  });

  it('does not coerce a non-numeric query value against a number', () => {
    expect(looseEquals(30, 'thirty')).toBe(false);
    expect(looseEquals(0, '')).toBe(false);
  });

  it('matches any element of a stored array', () => {
    expect(looseEquals(['a', 'b'], 'b')).toBe(true);
    expect(looseEquals(['a', 'b'], 'c')).toBe(false);
  });
});

const people: MockRecord[] = [
  { id: '1', name: 'Ada Lovelace', city: 'London', age: 36, active: true, score: 9 },
  { id: '2', name: 'Grace Hopper', city: 'New York', age: 45, active: true, score: 10 },
  { id: '3', name: 'alan turing', city: 'London', age: 41, active: false, score: 8 },
  { id: '4', name: 'Edsger Dijkstra', city: 'Rotterdam', age: 72, active: false },
];

const names = (records: readonly MockRecord[]): unknown[] => records.map((r) => r['name']);

describe('selectRecords — filtering', () => {
  it('ANDs every filter together', () => {
    const selected = selectRecords(
      people,
      plan({
        filters: [
          { field: 'city', operator: 'eq', value: 'London', values: [] },
          { field: 'active', operator: 'eq', value: 'true', values: [] },
        ],
      }),
      fields.searchable,
    );
    expect(names(selected)).toEqual(['Ada Lovelace']);
  });

  it('applies each comparison operator', () => {
    const only = (operator: QueryPlan['filters'][number]['operator'], value: string) =>
      names(
        selectRecords(
          people,
          plan({ filters: [{ field: 'age', operator, value, values: [] }] }),
          [],
        ),
      );
    expect(only('gt', '45')).toEqual(['Edsger Dijkstra']);
    expect(only('gte', '45')).toEqual(['Grace Hopper', 'Edsger Dijkstra']);
    expect(only('lt', '41')).toEqual(['Ada Lovelace']);
    expect(only('lte', '41')).toEqual(['Ada Lovelace', 'alan turing']);
    expect(only('ne', '36')).toEqual(['Grace Hopper', 'alan turing', 'Edsger Dijkstra']);
  });

  it('matches _like case-insensitively as a substring', () => {
    const selected = selectRecords(
      people,
      plan({ filters: [{ field: 'name', operator: 'like', value: 'ADA', values: [] }] }),
      [],
    );
    expect(names(selected)).toEqual(['Ada Lovelace']);
  });

  it('matches any of the _in values', () => {
    const selected = selectRecords(
      people,
      plan({
        filters: [{ field: 'city', operator: 'in', value: '', values: ['London', 'Rotterdam'] }],
      }),
      [],
    );
    expect(names(selected)).toEqual(['Ada Lovelace', 'alan turing', 'Edsger Dijkstra']);
  });

  it('never matches an ordering comparison against a missing value', () => {
    // Dijkstra has no score. `score_gte=0` must not sweep him in just because
    // the absent value compares as zero.
    const selected = selectRecords(
      people,
      plan({ filters: [{ field: 'score', operator: 'gte', value: '0', values: [] }] }),
      [],
    );
    expect(names(selected)).not.toContain('Edsger Dijkstra');
    expect(selected).toHaveLength(3);
  });

  it('finds missing values through the null literal', () => {
    const selected = selectRecords(
      people,
      plan({ filters: [{ field: 'score', operator: 'eq', value: 'null', values: [] }] }),
      [],
    );
    expect(names(selected)).toEqual(['Edsger Dijkstra']);
  });

  it('counts a missing value as not-equal for _ne', () => {
    const selected = selectRecords(
      people,
      plan({ filters: [{ field: 'score', operator: 'ne', value: '8', values: [] }] }),
      [],
    );
    expect(names(selected)).toContain('Edsger Dijkstra');
  });
});

describe('selectRecords — search', () => {
  it('ORs across the searchable fields, case-insensitively', () => {
    expect(names(selectRecords(people, plan({ search: 'london' }), fields.searchable))).toEqual([
      'Ada Lovelace',
      'alan turing',
    ]);
    expect(names(selectRecords(people, plan({ search: 'grace' }), fields.searchable))).toEqual([
      'Grace Hopper',
    ]);
  });

  it('only looks at the searchable whitelist', () => {
    // 36 is Ada's age, which is not a searchable field.
    expect(selectRecords(people, plan({ search: '36' }), fields.searchable)).toEqual([]);
  });

  it('combines with filters rather than replacing them', () => {
    const selected = selectRecords(
      people,
      plan({
        search: 'a',
        filters: [{ field: 'city', operator: 'eq', value: 'London', values: [] }],
      }),
      fields.searchable,
    );
    expect(names(selected)).toEqual(['Ada Lovelace', 'alan turing']);
  });

  it('matches nothing when no field is searchable', () => {
    expect(selectRecords(people, plan({ search: 'ada' }), [])).toEqual([]);
  });

  it('does not mutate the input collection', () => {
    const before = [...people];
    selectRecords(people, plan({ search: 'ada' }), fields.searchable);
    expect(people).toEqual(before);
  });
});

describe('sortRecords', () => {
  it('orders ascending and descending', () => {
    expect(
      names(sortRecords(people, plan({ sort: [{ field: 'age', direction: 1 }] }), 'id')),
    ).toEqual(['Ada Lovelace', 'alan turing', 'Grace Hopper', 'Edsger Dijkstra']);
    expect(
      names(sortRecords(people, plan({ sort: [{ field: 'age', direction: -1 }] }), 'id')),
    ).toEqual(['Edsger Dijkstra', 'Grace Hopper', 'alan turing', 'Ada Lovelace']);
  });

  it('sorts case-insensitively, so mixed case interleaves', () => {
    expect(
      names(sortRecords(people, plan({ sort: [{ field: 'name', direction: 1 }] }), 'id')),
    ).toEqual(['Ada Lovelace', 'alan turing', 'Edsger Dijkstra', 'Grace Hopper']);
  });

  it('puts records missing the field last in both directions', () => {
    // A page full of blanks is never the useful answer, so absence is not
    // treated as a value that can be ordered.
    const ascending = sortRecords(people, plan({ sort: [{ field: 'score', direction: 1 }] }), 'id');
    const descending = sortRecords(
      people,
      plan({ sort: [{ field: 'score', direction: -1 }] }),
      'id',
    );
    expect(ascending[ascending.length - 1]?.['name']).toBe('Edsger Dijkstra');
    expect(descending[descending.length - 1]?.['name']).toBe('Edsger Dijkstra');
  });

  it('falls through to the next sort key on a tie', () => {
    const sorted = sortRecords(
      people,
      plan({
        sort: [
          { field: 'city', direction: 1 },
          { field: 'age', direction: -1 },
        ],
      }),
      'id',
    );
    expect(names(sorted)).toEqual([
      'alan turing',
      'Ada Lovelace',
      'Grace Hopper',
      'Edsger Dijkstra',
    ]);
  });

  it('breaks a full tie on identity, giving a reproducible total order', () => {
    // Without this, two records with equal sort keys could swap between the
    // request for page 1 and the request for page 2 — showing one twice and the
    // other never.
    const tied: MockRecord[] = [
      { id: '3', city: 'London' },
      { id: '1', city: 'London' },
      { id: '2', city: 'London' },
    ];
    const sorted = sortRecords(tied, plan({ sort: [{ field: 'city', direction: 1 }] }), 'id');
    expect(sorted.map((r) => r['id'])).toEqual(['1', '2', '3']);
    // Same input in a different order yields the same output.
    const shuffled = sortRecords(
      [tied[1]!, tied[2]!, tied[0]!],
      plan({ sort: [{ field: 'city', direction: 1 }] }),
      'id',
    );
    expect(shuffled.map((r) => r['id'])).toEqual(['1', '2', '3']);
  });

  it('leaves the stored order alone when nothing is sorted', () => {
    expect(names(sortRecords(people, plan(), 'id'))).toEqual(names(people));
  });

  it('does not mutate the input collection', () => {
    const before = [...people];
    sortRecords(people, plan({ sort: [{ field: 'age', direction: -1 }] }), 'id');
    expect(people).toEqual(before);
  });
});

describe('paginate', () => {
  it('slices the page and reports the pre-slice total', () => {
    expect(paginate(people, plan({ page: 2, limit: 2 }))).toEqual({
      data: [people[2], people[3]],
      total: 4,
    });
  });

  it('returns an empty page past the end, keeping the total', () => {
    expect(paginate(people, plan({ page: 9, limit: 2 }))).toEqual({ data: [], total: 4 });
  });
});

describe('expandIncludes', () => {
  const students: MockRecord[] = [
    { id: '1', name: 'Ada', classroomId: 10, courseIds: ['c1', 'c2'] },
    { id: '2', name: 'Grace', classroomId: 11, courseIds: [] },
    { id: '3', name: 'Alan', classroomId: null, courseIds: ['c2'] },
  ];
  const classrooms: MockRecord[] = [
    { id: 10, name: 'Room A' },
    { id: 11, name: 'Room B' },
  ];
  const courses: MockRecord[] = [
    { id: 'c1', title: 'Logic' },
    { id: 'c2', title: 'Algorithms' },
  ];

  const belongsTo: IncludeTarget = {
    name: 'classroom',
    targetPath: 'classroom',
    localField: 'classroomId',
    foreignField: 'id',
    collection: false,
  };
  const manyToMany: IncludeTarget = {
    name: 'courses',
    targetPath: 'course',
    localField: 'courseIds',
    foreignField: 'id',
    collection: true,
  };

  const loader = (rows: Record<string, MockRecord[]>) =>
    vi.fn(async (targetPath: string) => rows[targetPath] ?? []);

  it('expands an owning relation to a single record', async () => {
    const load = loader({ classroom: classrooms });
    const expanded = await expandIncludes(students, [belongsTo], load);
    expect(expanded[0]?.['classroom']).toEqual({ id: 10, name: 'Room A' });
    expect(expanded[1]?.['classroom']).toEqual({ id: 11, name: 'Room B' });
  });

  it('expands an unmatched single relation to null, not to undefined', async () => {
    // The key is explicitly present and null, so a client can tell "no related
    // record" from "the relation was not requested".
    const expanded = await expandIncludes(students, [belongsTo], loader({ classroom: classrooms }));
    expect(expanded[2]).toHaveProperty('classroom', null);
  });

  it('matches across a number/string key boundary', async () => {
    // classroomId is an integer identity; a seed may hold either form.
    const expanded = await expandIncludes(
      [{ id: '1', classroomId: '10' }],
      [belongsTo],
      loader({ classroom: classrooms }),
    );
    expect(expanded[0]?.['classroom']).toEqual({ id: 10, name: 'Room A' });
  });

  it('expands a collection relation to an array, empty when nothing matches', async () => {
    const expanded = await expandIncludes(students, [manyToMany], loader({ course: courses }));
    expect(expanded[0]?.['courses']).toEqual([
      { id: 'c1', title: 'Logic' },
      { id: 'c2', title: 'Algorithms' },
    ]);
    expect(expanded[1]?.['courses']).toEqual([]);
    expect(expanded[2]?.['courses']).toEqual([{ id: 'c2', title: 'Algorithms' }]);
  });

  it('indexes an array-valued foreign key, so an inverse many-to-many resolves', async () => {
    const inverse: IncludeTarget = {
      name: 'students',
      targetPath: 'student',
      localField: 'id',
      foreignField: 'courseIds',
      collection: true,
    };
    const expanded = await expandIncludes(courses, [inverse], loader({ student: students }));
    expect((expanded[1]?.['students'] as MockRecord[]).map((s) => s['name'])).toEqual([
      'Ada',
      'Alan',
    ]);
  });

  it('loads each target entity once, however many records are on the page', async () => {
    // The N+1 guard: cost tracks the number of relations, not the page size.
    const load = loader({ classroom: classrooms, course: courses });
    await expandIncludes(students, [belongsTo, manyToMany], load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([path]) => path)).toEqual(['classroom', 'course']);
  });

  it('shares one load between two relations pointing at the same entity', async () => {
    const load = loader({ classroom: classrooms });
    const second: IncludeTarget = { ...belongsTo, name: 'homeroom' };
    const expanded = await expandIncludes(students, [belongsTo, second], load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(expanded[0]?.['homeroom']).toEqual({ id: 10, name: 'Room A' });
  });

  it('does no work and no loads when nothing is included', async () => {
    const load = loader({});
    expect(await expandIncludes(students, [], load)).toEqual(students);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not mutate the records it was given', async () => {
    const before = JSON.parse(JSON.stringify(students));
    await expandIncludes(students, [belongsTo], loader({ classroom: classrooms }));
    expect(students).toEqual(before);
  });

  it('lets an expansion overwrite a same-named own field', async () => {
    // Only reachable when a relation and a field share a name, and the caller
    // asked for the relation by that name — so the relation is what they meant.
    const shadowed: MockRecord[] = [{ id: '1', classroomId: 10, classroom: 'Room A (text)' }];
    const expanded = await expandIncludes(shadowed, [belongsTo], loader({ classroom: classrooms }));
    expect(expanded[0]?.['classroom']).toEqual({ id: 10, name: 'Room A' });
  });
});

import { describe, it, expect } from 'vitest';

import {
  classifyChangeType,
  classifyImpact,
  groupChanges,
  type SchemaChange,
} from '@instantmockapi/ips';
import { capValue, toChangeTreeView, toChangeView } from './change-serializers.js';

/**
 * The capping discipline, tested at the level it lives at.
 *
 * A route test cannot reach this: triggering truncation through HTTP needs a
 * diff of thousands of changes, and the rule being defended is a property of
 * the serializer rather than of the endpoint. So these call it directly with a
 * small budget.
 *
 * The rule: **cap the body, never the counts.** A header that reads "412
 * changes, 2 breaking" over a list of a hundred is honest. A header that reads
 * "100 changes" because the list was trimmed is a lie the reader cannot detect.
 */

function change(over: Partial<SchemaChange> = {}): SchemaChange {
  return {
    kind: 'FIELD_TYPE_CHANGED',
    risk: 'BREAKING',
    aspect: 'both',
    entityId: 'ent_1',
    entityName: 'User',
    fieldId: 'fld_1',
    fieldName: 'age',
    before: 'integer',
    after: 'string',
    summary: 'Field User.age type changed',
    ...over,
  };
}

/** `count` changes spread across distinct fields of one entity. */
function manyFields(entityName: string, count: number): SchemaChange[] {
  return Array.from({ length: count }, (_, index) =>
    change({
      entityId: `ent_${entityName}`,
      entityName,
      fieldId: `fld_${entityName}_${index}`,
      fieldName: `field${index}`,
      summary: `Field ${entityName}.field${index} type changed`,
    }),
  );
}

const view = (changes: readonly SchemaChange[], budget: number) =>
  toChangeTreeView(groupChanges(changes), budget);

describe('the counts are never capped', () => {
  it('reports the true total even when the body is trimmed', () => {
    const changes = manyFields('User', 250);
    const result = view(changes, 40);

    // The body was cut...
    expect(result.truncated).not.toBeNull();
    // ...and the header still tells the truth.
    expect((result.tree['counts'] as { total: number }).total).toBe(250);
  });

  it('keeps an entity group’s own counts uncapped', () => {
    const changes = manyFields('User', 250);
    const result = view(changes, 40);

    const entity = (
      result.tree['entities'] as { counts: { total: number }; fields: unknown[] }[]
    )[0]!;
    // The group header says 250 while showing far fewer rows, and says how many
    // it left out — rather than quietly reporting a smaller number.
    expect(entity.counts.total).toBe(250);
    expect(entity.fields.length).toBeLessThan(250);
  });

  it('reports the breaking count over everything, not over what survived', () => {
    // The one number a reader acts on. Under-reporting it because the rows were
    // trimmed is the most damaging possible truncation bug.
    const changes = manyFields('User', 250);
    const result = view(changes, 40);

    expect((result.tree['counts'] as { breaking: number }).breaking).toBe(250);
  });
});

describe('truncation is per entity, never from the tail', () => {
  /**
   * A global tail-cut makes the last entities vanish entirely. Per-entity
   * capping keeps every entity visible with an honest "+N more" affordance,
   * which is the difference between a trimmed list and a missing one.
   */
  it('keeps every entity visible when each is individually large', () => {
    const changes = [
      ...manyFields('Alpha', 150),
      ...manyFields('Beta', 150),
      ...manyFields('Gamma', 150),
    ];
    const result = view(changes, 400);

    const entities = result.tree['entities'] as { name: string; omittedChanges: number }[];
    expect(entities.map((entity) => entity.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // Each was trimmed, none was dropped.
    expect(entities.every((entity) => entity.omittedChanges > 0)).toBe(true);
  });

  it('records what it dropped, so nothing is elided silently', () => {
    const result = view(manyFields('User', 250), 40);
    expect(result.truncated!.omittedChanges).toBeGreaterThan(0);
  });

  it('reports an entity dropped whole only once the whole budget is gone', () => {
    const changes = [...manyFields('Alpha', 300), ...manyFields('Beta', 300)];
    // A budget smaller than one entity's allowance: Beta cannot be reached.
    const result = view(changes, 60);

    expect(result.truncated!.omittedEntities).toBeGreaterThan(0);
    // And its changes are still counted in the total.
    expect((result.tree['counts'] as { total: number }).total).toBe(600);
  });

  it('truncates nothing for an ordinary diff', () => {
    const result = view(manyFields('User', 5), 2000);
    expect(result.truncated).toBeNull();
    const entity = (result.tree['entities'] as { omittedChanges: number; fields: unknown[] }[])[0]!;
    expect(entity.omittedChanges).toBe(0);
    expect(entity.fields).toHaveLength(5);
  });
});

describe('capValue', () => {
  it('leaves anything realistic untouched', () => {
    // A type name, a bound, a flag, an enum list — nothing a field payload
    // actually holds should ever be truncated.
    for (const value of ['integer', 3, true, null, { name: 'age', type: 'integer' }, [1, 2, 3]]) {
      expect(capValue(value)).toEqual(value === null ? null : value);
    }
  });

  it('caps a value too large to send, with a preview and a size', () => {
    // A `default` on an object-typed field is effectively unbounded, so one
    // pathological value must not be able to dominate a response.
    const huge = { note: 'x'.repeat(5000) };
    const capped = capValue(huge) as { __truncated: boolean; preview: string; bytes: number };

    expect(capped.__truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(5000);
    expect(capped.preview.length).toBeLessThan(250);
  });

  it('normalises absent to null rather than dropping the key', () => {
    // The client distinguishes "no before" (an addition) from "before was
    // null", and an absent key would make those indistinguishable.
    expect(capValue(undefined)).toBeNull();
  });

  it('never throws on a value a stored snapshot could hold', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => capValue(cyclic)).not.toThrow();
    expect((capValue(cyclic) as { __truncated: boolean }).__truncated).toBe(true);
  });
});

describe('toChangeView', () => {
  it('keeps every field the draft payload already sent, spelled the same way', () => {
    // The compatibility contract: `review-changes.tsx` reads these and was not
    // edited when the comparison endpoint was added.
    const wire = toChangeView(change());
    for (const key of [
      'kind',
      'risk',
      'aspect',
      'entity',
      'field',
      'path',
      'before',
      'after',
      'summary',
    ]) {
      expect(wire, key).toHaveProperty(key);
    }
    expect(wire['entity']).toBe('User');
    expect(wire['field']).toBe('age');
  });

  it('adds the stable ids the client never used to get', () => {
    const wire = toChangeView(change());
    expect(wire['entityId']).toBe('ent_1');
    expect(wire['fieldId']).toBe('fld_1');
  });

  it('computes both projections once, on the server', () => {
    // So two clients cannot classify the same change differently.
    const source = change();
    const wire = toChangeView(source);
    expect(wire['changeType']).toBe(classifyChangeType(source));
    expect(wire['impact']).toBe(classifyImpact(source));
  });

  it('defaults matchedBy to id rather than leaving it absent', () => {
    expect(toChangeView(change())['matchedBy']).toBe('id');
    expect(toChangeView(change({ matchedBy: 'name' }))['matchedBy']).toBe('name');
  });

  it('falls back to the relation name in the legacy `field` key', () => {
    // A known conflation kept for compatibility — and exactly why grouping keys
    // on the ids rather than on this.
    const wire = toChangeView(
      change({
        kind: 'RELATION_RENAMED',
        fieldId: undefined,
        fieldName: undefined,
        relationId: 'rel_1',
        relationName: 'buyer',
      }),
    );
    expect(wire['field']).toBe('buyer');
    expect(wire['relationId']).toBe('rel_1');
  });
});

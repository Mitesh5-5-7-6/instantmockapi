import { describe, it, expect } from 'vitest';

import {
  formatPath,
  parseErrorPath,
  PathIndexBuilder,
  resolveDetails,
  resolvePath,
  type FieldPathIndex,
} from './error-paths';

describe('parseErrorPath', () => {
  it('splits the shape the API actually sends', () => {
    expect(parseErrorPath('entities[1].fields[1].name')).toEqual([
      { key: 'entities', index: 1 },
      { key: 'fields', index: 1 },
      { key: 'name', index: null },
    ]);
  });

  it('handles an unindexed path', () => {
    expect(parseErrorPath('generationConfig.methods')).toEqual([
      { key: 'generationConfig', index: null },
      { key: 'methods', index: null },
    ]);
  });

  it('handles the deep path a nested object produces', () => {
    expect(parseErrorPath('entities[0].fields[3].children[0].name')).toHaveLength(4);
  });

  it('splits a doubly-indexed key into separate steps', () => {
    // So a prefix can stop between the two indices.
    expect(parseErrorPath('matrix[0][1]')).toEqual([
      { key: 'matrix', index: 0 },
      { key: '', index: 1 },
    ]);
  });

  /**
   * These strings arrive over the wire. A permissive parser would invent
   * segments and mis-attribute an error to a real field, so anything unexpected
   * parses to nothing and is reported unmapped.
   */
  it.each(['', '   ', 'entities[', 'entities[a]', '.name', 'entities..name', 'entities[1]extra'])(
    'refuses to guess at %o',
    (path) => {
      expect(parseErrorPath(path)).toEqual([]);
    },
  );
});

describe('formatPath', () => {
  it('round-trips every path it can parse', () => {
    for (const path of [
      'entities[1].fields[1].name',
      'generationConfig.methods',
      'entities[0].relations[2].target',
      'body.name',
      'matrix[0][1]',
    ]) {
      expect(formatPath(parseErrorPath(path))).toBe(path);
    }
  });
});

describe('PathIndexBuilder', () => {
  it('records the path it was standing on', () => {
    const builder = new PathIndexBuilder();
    builder.at('entities', 0, () => {
      builder.claim('ent-a');
      builder.at('fields', 1, () => builder.claim('fld-b'));
    });

    const index = builder.build();
    expect(index.get('entities[0]')).toBe('ent-a');
    expect(index.get('entities[0].fields[1]')).toBe('fld-b');
  });

  it('pops the path even when the body throws', () => {
    const builder = new PathIndexBuilder();
    expect(() =>
      builder.at('entities', 0, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // Not nested under the abandoned entity.
    builder.at('entities', 1, () => builder.claim('ent-b'));
    expect(builder.build().get('entities[1]')).toBe('ent-b');
  });

  it('ignores a claim made at the root', () => {
    const builder = new PathIndexBuilder();
    builder.claim('nowhere');
    expect(builder.build().size).toBe(0);
  });
});

/**
 * The index the project wizard would build for this form:
 *
 *   form:     [ Draft (excluded), User, Order (unnamed) ]
 *   payload:  [ User ]                       ← pruning shifted every index
 *
 * and inside User the form has a blank field row that is filtered out, so the
 * form's third field is the payload's second.
 */
function wizardIndex(): FieldPathIndex {
  const builder = new PathIndexBuilder();
  builder.at('entities', 0, () => {
    builder.claim('ent-user');
    builder.at('fields', 0, () => builder.claim('fld-user-name'));
    builder.at('fields', 1, () => builder.claim('fld-user-email'));
  });
  return builder.build();
}

describe('resolvePath', () => {
  const index = wizardIndex();

  /**
   * The case from the spec. `entities[1]` in the *payload* is `entities[0]` here
   * because an excluded entity was pruned — which is exactly why the index is
   * built during payload construction rather than derived from the form.
   */
  it('resolves a field path to the field, not its entity', () => {
    expect(resolvePath('entities[0].fields[1].name', index)).toBe('fld-user-email');
  });

  it('resolves an entity path to the entity', () => {
    expect(resolvePath('entities[0].name', index)).toBe('ent-user');
  });

  /**
   * Longest-prefix matching is what makes the two cases above differ. Without
   * it, a bad field name would highlight the whole entity.
   */
  it('prefers the deepest match available', () => {
    expect(resolvePath('entities[0].fields[0].validation.min', index)).toBe('fld-user-name');
  });

  it('resolves a path deeper than anything indexed to the nearest owner', () => {
    expect(resolvePath('entities[0].fields[1].validation.regex.flags', index)).toBe(
      'fld-user-email',
    );
  });

  /** A path into a pruned entity names nothing the form is showing at all. */
  it('refuses to guess for an entity the payload never contained', () => {
    expect(resolvePath('entities[7].name', index)).toBeNull();
  });

  /**
   * The contract when a leaf is unknown: climb to the nearest indexed ancestor,
   * never sideways to a sibling.
   *
   * `fields[9]` does not exist here, so the error lands on the entity card —
   * "something in this entity is wrong" is honest and still locates the problem.
   * Attaching it to `fields[0]` because that field does exist would point at a
   * control the user can edit, that was never broken, and whose message will not
   * clear however they change it.
   */
  it('climbs to the nearest indexed ancestor for an unknown leaf', () => {
    expect(resolvePath('entities[0].fields[9].name', index)).toBe('ent-user');
    expect(resolvePath('entities[0].fields[9].name', index)).not.toBe('fld-user-name');
  });

  it('refuses to guess for a path that names no field at all', () => {
    expect(resolvePath('generationConfig.methods', index)).toBeNull();
    expect(resolvePath('projectId', index)).toBeNull();
  });

  it('refuses to guess for an unparseable path', () => {
    expect(resolvePath('entities[', index)).toBeNull();
  });
});

describe('resolveDetails', () => {
  const index = wizardIndex();

  it('splits what the form can show from what it cannot', () => {
    const { mapped, unmapped } = resolveDetails(
      [
        { path: 'entities[0].fields[1].name', issue: 'Field name must be alphanumeric' },
        { path: 'entities[0].name', issue: 'Entity name is invalid' },
        { path: 'generationConfig.methods', issue: 'at least one method is required' },
      ],
      index,
    );

    expect(mapped.get('fld-user-email')).toEqual(['Field name must be alphanumeric']);
    expect(mapped.get('ent-user')).toEqual(['Entity name is invalid']);
    // The reason the summarising toast still has to exist.
    expect(unmapped).toEqual([
      { path: 'generationConfig.methods', issue: 'at least one method is required' },
    ]);
  });

  it('collects several issues for one field', () => {
    const { mapped } = resolveDetails(
      [
        { path: 'entities[0].fields[0].name', issue: 'is required' },
        { path: 'entities[0].fields[0].type', issue: 'is not a known type' },
      ],
      index,
    );
    expect(mapped.get('fld-user-name')).toEqual(['is required', 'is not a known type']);
  });

  it('does not repeat an identical issue', () => {
    const { mapped } = resolveDetails(
      [
        { path: 'entities[0].fields[0].name', issue: 'is required' },
        { path: 'entities[0].fields[0].name', issue: 'is required' },
      ],
      index,
    );
    expect(mapped.get('fld-user-name')).toEqual(['is required']);
  });

  it('maps nothing when the index is empty', () => {
    const details = [{ path: 'entities[0].name', issue: 'nope' }];
    const { mapped, unmapped } = resolveDetails(details, new Map());
    expect(mapped.size).toBe(0);
    expect(unmapped).toEqual(details);
  });

  it('handles an empty detail list', () => {
    const { mapped, unmapped } = resolveDetails([], index);
    expect(mapped.size).toBe(0);
    expect(unmapped).toEqual([]);
  });
});

describe('the editor’s reordered fields', () => {
  /**
   * `applyBuilderToIps` writes identity first, then authored fields, then
   * foreign keys — and the form renders none of the derived ones. So payload
   * `fields[0]` is the identity field and payload `fields[3]` is a foreign key,
   * with only the middle two belonging to anything on screen.
   */
  function editorIndex(): FieldPathIndex {
    const builder = new PathIndexBuilder();
    builder.at('entities', 0, () => {
      builder.claim('ent-user');
      // fields[0] is the identity field — deliberately unclaimed.
      builder.at('fields', 1, () => builder.claim('fld-email'));
      builder.at('fields', 2, () => builder.claim('fld-age'));
      // fields[3] is a foreign key — deliberately unclaimed.
    });
    return builder.build();
  }

  it('maps an authored field through the offset', () => {
    expect(resolvePath('entities[0].fields[2].type', editorIndex())).toBe('fld-age');
  });

  /**
   * The failure mode this guards against: without the identity slot left
   * unclaimed, an error on the identity field would be shown under the first
   * authored field — a control the user can edit, that was never broken, and
   * whose error will not clear however they change it.
   */
  it('reports an error on a hidden derived field as unmapped, not as the first authored one', () => {
    const index = editorIndex();
    expect(resolvePath('entities[0].fields[0].type', index)).toBe('ent-user');
    expect(resolvePath('entities[0].fields[3].name', index)).toBe('ent-user');
    // Neither is attributed to a field the user is looking at.
    expect(resolvePath('entities[0].fields[0].type', index)).not.toBe('fld-email');
  });
});

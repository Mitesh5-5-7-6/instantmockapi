import { describe, it, expect } from 'vitest';
import {
  buildMeta,
  buildValidation,
  builderFieldToIPS,
  coerceDefault,
  hasEmptyEnum,
  newEntity,
  newField,
  suggestFor,
  type BuilderField,
} from './builder';

function field(overrides: Partial<BuilderField> = {}): BuilderField {
  return { ...newField('title'), ...overrides };
}

describe('coerceDefault', () => {
  it('treats an empty default as absent rather than as an empty string', () => {
    expect(coerceDefault(field({ default: '' }))).toBeNull();
  });

  it('parses numerics and rejects garbage back to null', () => {
    expect(coerceDefault(field({ type: 'integer', default: '42' }))).toBe(42);
    expect(coerceDefault(field({ type: 'decimal', default: '1.5' }))).toBe(1.5);
    expect(coerceDefault(field({ type: 'number', default: 'abc' }))).toBeNull();
  });

  it('reads only the literal true as a boolean default', () => {
    expect(coerceDefault(field({ type: 'boolean', default: 'true' }))).toBe(true);
    expect(coerceDefault(field({ type: 'boolean', default: 'false' }))).toBe(false);
    expect(coerceDefault(field({ type: 'boolean', default: 'yes' }))).toBe(false);
  });
});

describe('buildValidation — rules are scoped to the field type', () => {
  it('keeps string rules on strings', () => {
    const rules = buildValidation(
      field({ type: 'string', validation: { email: true, min: '2', max: '50', regex: '^a' } }),
    );
    expect(rules).toEqual({ email: true, min: 2, max: 50, regex: '^a' });
  });

  it('drops rules left over from a type the field no longer has', () => {
    // Switching string → boolean must not leave a `min` behind: the generators
    // would honour it as a length rule on a value that has no length.
    const rules = buildValidation(
      field({ type: 'boolean', validation: { min: '2', email: true, regex: '^a' } }),
    );
    expect(rules).toEqual({});
  });

  it('applies min/max numerically to numbers but not the string-only rules', () => {
    const rules = buildValidation(
      field({ type: 'integer', validation: { min: '1', max: '10', length: '5', uuid: true } }),
    );
    expect(rules).toEqual({ min: 1, max: 10 });
  });

  it('trims and compacts enum values', () => {
    const rules = buildValidation(
      field({ type: 'enum', validation: { enum: [' draft ', '', 'published'] } }),
    );
    expect(rules).toEqual({ enum: ['draft', 'published'] });
  });

  it('emits arrayLength only when a bound was given', () => {
    expect(buildValidation(field({ type: 'array', validation: {} }))).toEqual({});
    expect(buildValidation(field({ type: 'array', validation: { arrayMin: '1' } }))).toEqual({
      arrayLength: { min: 1 },
    });
  });

  it('carries a custom message on any type', () => {
    expect(buildValidation(field({ type: 'date', validation: { message: 'bad date' } }))).toEqual({
      message: 'bad date',
    });
  });
});

describe('buildMeta', () => {
  it('writes unique when set', () => {
    expect(buildMeta(field({ validation: { unique: true } }))).toEqual({ unique: true });
  });

  it('writes searchable on a textual field', () => {
    expect(buildMeta(field({ type: 'string', validation: { searchable: true } }))).toEqual({
      searchable: true,
    });
    expect(buildMeta(field({ type: 'enum', validation: { searchable: true } }))).toEqual({
      searchable: true,
    });
  });

  it('omits searchable on a field where it would be ignored downstream', () => {
    // The IPS default only searches textual scalars, so writing the flag on an
    // object would claim a capability nothing honours.
    expect(buildMeta(field({ type: 'object', validation: { searchable: true } }))).toEqual({});
    expect(buildMeta(field({ type: 'boolean', validation: { searchable: true } }))).toEqual({});
  });

  it('returns an empty object rather than undefined when nothing is set', () => {
    // Generators dereference meta directly; a missing object crashes them.
    expect(buildMeta(field())).toEqual({});
  });
});

describe('builderFieldToIPS', () => {
  it('serializes a scalar into a complete IPS field node', () => {
    expect(builderFieldToIPS(field({ name: 'email', type: 'string', required: true }))).toEqual({
      name: 'email',
      type: 'string',
      required: true,
      default: null,
      children: [],
      validation: {},
      meta: {},
    });
  });

  it('takes every named child of an object and drops the unnamed ones', () => {
    const parent = field({
      name: 'address',
      type: 'object',
      children: [newField('city'), newField(''), newField('zip')],
    });
    const node = builderFieldToIPS(parent) as { children: { name: string }[] };
    expect(node.children.map((child) => child.name)).toEqual(['city', 'zip']);
  });

  it('takes only the first child of an array as its element definition', () => {
    const parent = field({
      name: 'tags',
      type: 'array',
      children: [newField('tag'), newField('ignored')],
    });
    const node = builderFieldToIPS(parent) as { children: { name: string }[] };
    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.name).toBe('tag');
  });

  it('emits no children for an array whose element was never defined', () => {
    const node = builderFieldToIPS(field({ type: 'array', children: [] })) as {
      children: unknown[];
    };
    expect(node.children).toEqual([]);
  });

  it('recurses to arbitrary depth', () => {
    const leaf = newField('deep');
    const middle = { ...newField('middle', 'object'), children: [leaf] };
    const root = { ...newField('root', 'object'), children: [middle] };
    const node = builderFieldToIPS(root) as {
      children: { children: { name: string }[] }[];
    };
    expect(node.children[0]?.children[0]?.name).toBe('deep');
  });
});

describe('hasEmptyEnum', () => {
  it('finds an enum with no usable values', () => {
    expect(hasEmptyEnum([field({ type: 'enum', validation: { enum: [] } })])).toBe(true);
    expect(hasEmptyEnum([field({ type: 'enum', validation: { enum: ['  '] } })])).toBe(true);
    expect(hasEmptyEnum([field({ type: 'enum', validation: { enum: ['a'] } })])).toBe(false);
  });

  it('looks inside nested children', () => {
    const nested = {
      ...newField('wrapper', 'object'),
      children: [field({ type: 'enum', validation: { enum: [] } })],
    };
    expect(hasEmptyEnum([nested])).toBe(true);
  });
});

describe('suggestFor', () => {
  it('suggests a format from a plainly-named string field', () => {
    expect(suggestFor(field({ name: 'contactEmail' }))?.label).toBe('email');
    expect(suggestFor(field({ name: 'website' }))?.label).toBe('url');
    expect(suggestFor(field({ name: 'externalGuid' }))?.label).toBe('uuid');
  });

  it('stays quiet once the rule is already set', () => {
    expect(suggestFor(field({ name: 'email', validation: { email: true } }))).toBeNull();
  });

  it('stays quiet on a non-string field', () => {
    expect(suggestFor(field({ name: 'email', type: 'integer' }))).toBeNull();
  });
});

describe('newEntity / newField', () => {
  it('gives every node a distinct id', () => {
    const ids = [newField().id, newField().id, newEntity().id];
    expect(new Set(ids).size).toBe(3);
  });

  it('starts an array field with an element definition already in place', () => {
    // Without it the author sees an array that cannot describe anything.
    expect(newField('tags', 'array').children).toHaveLength(1);
  });

  it('starts an entity included, int-identified, and with one field', () => {
    const entity = newEntity('Student');
    expect(entity).toMatchObject({ name: 'Student', generate: true, identityStyle: 'int' });
    expect(entity.fields).toHaveLength(1);
    expect(entity.relations).toEqual([]);
  });
});

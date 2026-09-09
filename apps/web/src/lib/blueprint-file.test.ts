import { describe, it, expect } from 'vitest';
import { describeKind, describeSurface, readBlueprintFile } from './blueprint-file';

/**
 * Reading a blueprint file client-side (Phase 4 §14, §17).
 *
 * The claim under test is a narrow one, and stating it is most of the value:
 * this rejects files that are obviously not blueprints and summarises the ones
 * that might be. It is **not** a validator — the server owns that, and §14
 * forbids a second error system — so every test below is either about a message
 * a user needs before a round trip, or about the preview.
 *
 * The important negative: a file that passes here may still be refused by the
 * server. Nothing here should ever grow an assertion that a blueprint is
 * *valid*.
 */

const blueprint = (over: Record<string, unknown> = {}) => ({
  blueprintVersion: 1,
  schemaVersion: '1.x',
  metadata: { sourceVersion: 7 },
  project: { name: 'Shop', description: 'A shop', kind: 'project' },
  entities: [
    { name: 'Post', fields: [{ name: 'title' }, { name: 'id' }], relations: [{ name: 'author' }] },
    { name: 'Author', fields: [{ name: 'email' }], relations: [] },
  ],
  generationConfig: { methods: ['GET'] },
  ...over,
});

const read = (value: unknown) => readBlueprintFile(JSON.stringify(value));

describe('rejecting a file that is not a blueprint', () => {
  it('says what to do when nothing was pasted', () => {
    const result = readBlueprintFile('   ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('choose a .json file');
  });

  it('names JSON when the text will not parse', () => {
    const result = readBlueprintFile('{ not json');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('not valid JSON');
  });

  it.each([
    ['an array', []],
    ['a number', 3],
    ['a string', 'shop'],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(read(value).ok).toBe(false);
  });

  /**
   * The likeliest wrong file is another JSON file from the same project — an
   * OpenAPI spec or a Postman collection, both of which the Files tab offers.
   * So the message names the missing field and says where a real one comes
   * from, rather than saying "invalid".
   */
  it('explains the difference from the project’s other JSON files', () => {
    const result = read({ openapi: '3.0.0', paths: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('blueprintVersion');
    expect(!result.ok && result.reason).toContain('Docs tab');
  });

  it('refuses a blueprint with no project name', () => {
    const result = read(blueprint({ project: { kind: 'project' } }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('no project name');
  });

  it('refuses a blank project name, not just a missing one', () => {
    expect(read(blueprint({ project: { name: '   ', kind: 'project' } })).ok).toBe(false);
  });
});

describe('the preview', () => {
  it('reads what is about to be created', () => {
    const result = read(blueprint());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.preview.name).toBe('Shop');
    expect(result.preview.kind).toBe('project');
    expect(result.preview.description).toBe('A shop');
    expect(result.preview.sourceVersion).toBe(7);
    expect(result.preview.blueprintVersion).toBe(1);
    expect(result.preview.entities).toEqual([
      { name: 'Post', fieldCount: 2, relationCount: 1 },
      { name: 'Author', fieldCount: 1, relationCount: 0 },
    ]);
  });

  it('returns the parsed document unchanged, for the request body', () => {
    const source = blueprint();
    const result = read(source);

    // The server must receive exactly what the file said — a preview that
    // normalised anything would import something the user did not review.
    expect(result.ok && result.blueprint).toEqual(source);
  });

  it('reads the auth mode when there is one', () => {
    const result = read(blueprint({ authentication: { mode: 'ALL_PROTECTED' } }));
    expect(result.ok && result.preview.authMode).toBe('ALL_PROTECTED');
  });

  it('reports no auth mode rather than guessing one', () => {
    expect(read(blueprint()).ok && read(blueprint()).ok).toBe(true);
    const result = read(blueprint());
    expect(result.ok && result.preview.authMode).toBeNull();
  });

  /**
   * A newer blueprint is *not* refused here.
   *
   * The server owns the version gate and its message says which way round the
   * mismatch is. Refusing here would mean maintaining the current version
   * number in two places, and the copy in the browser is the one that goes
   * stale.
   */
  it('previews a newer format rather than refusing it locally', () => {
    const result = read(blueprint({ blueprintVersion: 99 }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview.blueprintVersion).toBe(99);
  });

  it('survives entities that are missing their arrays', () => {
    const result = read(blueprint({ entities: [{ name: 'Bare' }] }));
    expect(result.ok && result.preview.entities).toEqual([
      { name: 'Bare', fieldCount: 0, relationCount: 0 },
    ]);
  });
});

describe('describeKind', () => {
  it('uses the same words as the kind chooser', () => {
    expect(describeKind('project')).toBe('Project API');
    expect(describeKind('single')).toBe('Single API');
    expect(describeKind('auth')).toBe('Auth API');
  });

  /** An unknown kind is shown as-is: the server will explain it. */
  it('does not normalise an unrecognised kind away', () => {
    expect(describeKind('enterprise')).toBe('enterprise');
  });
});

describe('describeSurface', () => {
  const preview = (over: Record<string, unknown> = {}) => {
    const result = read(blueprint(over));
    if (!result.ok) {
      throw new Error('fixture is not readable');
    }
    return result.preview;
  };

  it('counts entities, fields and relationships', () => {
    expect(describeSurface(preview())).toBe('2 entities · 3 fields · 1 relationship');
  });

  it('singularises one of each', () => {
    expect(
      describeSurface(preview({ entities: [{ name: 'Only', fields: [{ name: 'a' }] }] })),
    ).toBe('1 entity · 1 field');
  });

  it('omits relationships when there are none', () => {
    expect(describeSurface(preview({ entities: [{ name: 'A', fields: [] }] }))).toBe(
      '1 entity · 0 fields',
    );
  });

  /**
   * An Auth API project has no entities by design, so "No entities" alone would
   * read as an empty or broken file. It says what the surface *is* instead.
   */
  it('explains an empty entity list on an auth project', () => {
    expect(
      describeSurface(preview({ entities: [], authentication: { mode: 'ALL_PROTECTED' } })),
    ).toBe('No entities — the surface is the Auth API');
  });

  it('says only No entities when there is no auth either', () => {
    expect(describeSurface(preview({ entities: [] }))).toBe('No entities');
  });
});

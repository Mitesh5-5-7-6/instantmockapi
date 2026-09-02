import { describe, it, expect } from 'vitest';

import {
  applyBuilderToIps,
  ipsToBuilder,
  isDerivedField,
  isDirty,
  type IpsLike,
} from './draft-schema';

/**
 * A stored definition as the server actually returns one: materialized, with
 * stable ids, a derived identity field and a derived foreign key.
 */
function storedIps(): IpsLike {
  return {
    projectId: 'p1',
    version: 4,
    entities: [
      {
        id: 'ent_user',
        name: 'User',
        identity: { field: 'id', style: 'uuid' },
        description: 'People who use the product',
        fields: [
          {
            id: 'fld_id',
            name: 'id',
            type: 'uuid',
            required: false,
            default: null,
            children: [],
            validation: {},
            meta: { identity: true },
          },
          {
            id: 'fld_email',
            name: 'email',
            type: 'string',
            required: true,
            default: null,
            children: [],
            validation: { email: true, min: 5 },
            meta: { unique: true, searchable: true },
          },
          {
            id: 'fld_age',
            name: 'age',
            type: 'integer',
            required: false,
            default: 18,
            children: [],
            validation: { min: 0, max: 130 },
            meta: {},
          },
          {
            id: 'fld_addr',
            name: 'address',
            type: 'object',
            required: false,
            default: null,
            validation: {},
            meta: {},
            children: [
              {
                id: 'fld_city',
                name: 'city',
                type: 'string',
                required: false,
                default: null,
                children: [],
                validation: {},
                meta: {},
              },
            ],
          },
          {
            id: 'fld_teamid',
            name: 'teamId',
            type: 'uuid',
            required: false,
            default: null,
            children: [],
            validation: {},
            meta: { reference: true, relation: 'Team' },
          },
        ],
        relations: [
          {
            id: 'rel_team',
            name: 'team',
            kind: 'belongsTo',
            target: 'Team',
            required: false,
            onDelete: 'restrict',
            localField: 'teamId',
            foreignField: 'id',
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET'],
      mockRecords: 10,
    },
  };
}

const userEntity = (ips: IpsLike) => ips.entities![0]!;
const fieldNames = (ips: IpsLike) => userEntity(ips).fields!.map((f) => f.name);
const fieldIds = (ips: IpsLike) => userEntity(ips).fields!.map((f) => f.id);

describe('ipsToBuilder', () => {
  it('carries the stable ids onto every builder node', () => {
    const [entity] = ipsToBuilder(storedIps());
    expect(entity!.schemaId).toBe('ent_user');
    expect(entity!.fields.map((f) => f.schemaId)).toEqual(['fld_email', 'fld_age', 'fld_addr']);
    expect(entity!.fields[2]!.children[0]!.schemaId).toBe('fld_city');
    expect(entity!.relations[0]!.schemaId).toBe('rel_team');
  });

  it('gives every node a distinct UI key separate from its stable id', () => {
    const [entity] = ipsToBuilder(storedIps());
    const keys = entity!.fields.map((f) => f.id);
    expect(new Set(keys).size).toBe(keys.length);
    // The UI key is not the stable id — conflating them would make React keys
    // change on rename, or send form ids to the API.
    expect(keys).not.toContain('fld_email');
  });

  /**
   * The identity field and the foreign key are maintained by
   * `materializeRelations`. Showing them as editable rows would invite a user to
   * rename a key the server recreates on the next save.
   */
  it('hides server-derived fields from the form', () => {
    const [entity] = ipsToBuilder(storedIps());
    expect(entity!.fields.map((f) => f.name)).toEqual(['email', 'age', 'address']);
  });

  it('identifies derived fields by their metadata', () => {
    expect(isDerivedField({ name: 'id', type: 'uuid', meta: { identity: true } })).toBe(true);
    expect(isDerivedField({ name: 'teamId', type: 'uuid', meta: { reference: true } })).toBe(true);
    expect(isDerivedField({ name: 'email', type: 'string', meta: { unique: true } })).toBe(false);
    expect(isDerivedField({ name: 'email', type: 'string' })).toBe(false);
  });

  it('reads validation rules back into the form’s string fields', () => {
    const [entity] = ipsToBuilder(storedIps());
    expect(entity!.fields[0]!.validation).toEqual({
      email: true,
      min: '5',
      unique: true,
      searchable: true,
    });
    expect(entity!.fields[1]!.validation).toEqual({ min: '0', max: '130' });
  });

  it('renders a stored default as editable text', () => {
    const [entity] = ipsToBuilder(storedIps());
    expect(entity!.fields[1]!.default).toBe('18');
    // Null becomes an empty box, not the string "null".
    expect(entity!.fields[0]!.default).toBe('');
  });

  it('carries the identity style so the form does not reset it', () => {
    const [entity] = ipsToBuilder(storedIps());
    expect(entity!.identityStyle).toBe('uuid');
  });

  it('survives a definition with no entities', () => {
    expect(ipsToBuilder({})).toEqual([]);
    expect(ipsToBuilder({ entities: [] })).toEqual([]);
  });
});

describe('applyBuilderToIps', () => {
  /**
   * The property everything else rests on. A load-then-save with no edits must
   * produce the definition it started from — otherwise merely opening the editor
   * would show the user a diff they never made.
   */
  it('is a no-op round trip when nothing was edited', () => {
    const stored = storedIps();
    const result = applyBuilderToIps(stored, ipsToBuilder(stored));
    expect(result).toEqual(stored);
    expect(isDirty(stored, ipsToBuilder(stored))).toBe(false);
  });

  it('puts the derived fields back, ids and metadata intact', () => {
    const stored = storedIps();
    const result = applyBuilderToIps(stored, ipsToBuilder(stored));

    expect(fieldNames(result)).toEqual(['id', 'email', 'age', 'address', 'teamId']);
    const teamId = userEntity(result).fields!.find((f) => f.name === 'teamId');
    expect(teamId).toMatchObject({ id: 'fld_teamid', meta: { reference: true, relation: 'Team' } });
  });

  /** The whole reason ids are carried: a rename must stay one field changing. */
  it('keeps a field’s stable id across a rename', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields[0]!.name = 'emailAddress';

    const result = applyBuilderToIps(stored, entities);
    const renamed = userEntity(result).fields!.find((f) => f.name === 'emailAddress');
    expect(renamed?.id).toBe('fld_email');
    expect(fieldIds(result)).toEqual(fieldIds(stored));
  });

  it('keeps an entity’s stable id across a rename', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.name = 'Customer';

    const result = applyBuilderToIps(stored, entities);
    expect(userEntity(result)).toMatchObject({ id: 'ent_user', name: 'Customer' });
  });

  it('sends a newly added field with no id, for the server to mint', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields.push({
      id: 'ui-9',
      name: 'nickname',
      type: 'string',
      required: false,
      default: '',
      validation: {},
      children: [],
    });

    const result = applyBuilderToIps(stored, entities);
    const added = userEntity(result).fields!.find((f) => f.name === 'nickname');
    expect(added).toBeDefined();
    expect(added?.id).toBeUndefined();
  });

  it('drops a removed field without disturbing the rest', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields = entities[0]!.fields.filter((f) => f.name !== 'age');

    const result = applyBuilderToIps(stored, entities);
    expect(fieldNames(result)).toEqual(['id', 'email', 'address', 'teamId']);
  });

  it('ignores half-typed rows with no name', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields.push({
      id: 'ui-blank',
      name: '',
      type: 'string',
      required: false,
      default: '',
      validation: {},
      children: [],
    });

    expect(fieldNames(applyBuilderToIps(stored, entities))).toEqual(fieldNames(stored));
  });

  /**
   * `buildMeta` emits only `unique` and `searchable`. Replacing `meta` wholesale
   * would erase `readOnly`, `relation` and anything the server adds later.
   */
  it('merges metadata rather than replacing it', () => {
    const stored = storedIps();
    stored.entities![0]!.fields![1]!.meta = { unique: true, readOnly: true };

    const entities = ipsToBuilder(stored);
    const result = applyBuilderToIps(stored, entities);
    const email = userEntity(result).fields!.find((f) => f.name === 'email');
    expect(email?.meta).toEqual({ unique: true, readOnly: true });
  });

  /** ...but the two keys the form owns must still be clearable. */
  it('lets the form turn unique and searchable off', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    delete entities[0]!.fields[0]!.validation.unique;
    delete entities[0]!.fields[0]!.validation.searchable;

    const result = applyBuilderToIps(stored, entities);
    const email = userEntity(result).fields!.find((f) => f.name === 'email');
    expect(email?.meta).toEqual({});
  });

  it('preserves an entity description the form never shows', () => {
    const stored = storedIps();
    const result = applyBuilderToIps(stored, ipsToBuilder(stored));
    expect(userEntity(result).description).toBe('People who use the product');
  });

  it('preserves the relation link fields the form never shows', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.relations[0]!.onDelete = 'cascade';

    const result = applyBuilderToIps(stored, entities);
    expect(userEntity(result).relations![0]).toMatchObject({
      id: 'rel_team',
      onDelete: 'cascade',
      localField: 'teamId',
      foreignField: 'id',
    });
  });

  it('preserves the identity field name while letting the style change', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.identityStyle = 'int';

    const result = applyBuilderToIps(stored, entities);
    expect(userEntity(result).identity).toEqual({ field: 'id', style: 'int' });
  });

  it('keeps nested children matched by id through a nested rename', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields[2]!.children[0]!.name = 'town';

    const result = applyBuilderToIps(stored, entities);
    const address = userEntity(result).fields!.find((f) => f.name === 'address');
    expect(address?.children![0]).toMatchObject({ id: 'fld_city', name: 'town' });
  });

  it('carries top-level definition fields through untouched', () => {
    const stored = storedIps();
    const result = applyBuilderToIps(stored, ipsToBuilder(stored));
    expect(result.projectId).toBe('p1');
    expect(result.version).toBe(4);
    expect(result.generationConfig).toEqual(stored.generationConfig);
  });

  it('handles a brand-new entity with no stored counterpart', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities.push({
      id: 'ui-new',
      name: 'Order',
      fields: [
        {
          id: 'ui-total',
          name: 'total',
          type: 'integer',
          required: true,
          default: '',
          validation: {},
          children: [],
        },
      ],
      relations: [],
      identityStyle: 'int',
      generate: true,
    });

    const result = applyBuilderToIps(stored, entities);
    expect(result.entities).toHaveLength(2);
    expect(result.entities![1]).toMatchObject({
      name: 'Order',
      identity: { field: 'id', style: 'int' },
    });
    expect(result.entities![1]!.id).toBeUndefined();
  });
});

describe('isDirty', () => {
  it('is false for an untouched form and true after any edit', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    expect(isDirty(stored, entities)).toBe(false);

    entities[0]!.fields[0]!.required = false;
    expect(isDirty(stored, entities)).toBe(true);
  });

  it('does not count a half-typed row as an edit', () => {
    const stored = storedIps();
    const entities = ipsToBuilder(stored);
    entities[0]!.fields.push({
      id: 'ui-blank',
      name: '',
      type: 'string',
      required: false,
      default: '',
      validation: {},
      children: [],
    });
    expect(isDirty(stored, entities)).toBe(false);
  });
});

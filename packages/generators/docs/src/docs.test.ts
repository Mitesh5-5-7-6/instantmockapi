import { describe, it, expect } from 'vitest';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { goldenRelationsIPS } from '../../__tests__/golden-relations-fixture.js';
import {
  NO_QUERY_FEATURES,
  materializeRelations,
  type QueryFeatures,
} from '@instantmockapi/ips';
import { generateOpenAPI } from './openapi.js';
import { generatePostmanCollection } from './postman.js';
import type { EntityExamples } from './examples.js';

const examples: EntityExamples = {
  blogpost: [
    { id: 'a1b2', title: 'First post', published: true },
    { id: 'c3d4', title: 'Second post', published: false },
  ],
};

// Golden fixture selects GET, POST, PUT, DELETE — PATCH is NOT selected.

describe('generateOpenAPI (Worker E)', () => {
  const output = generateOpenAPI(goldenFixtureIPS, examples);
  const spec = JSON.parse(output['openapi.json'] ?? '{}');

  it('emits a single openapi.json file', () => {
    expect(Object.keys(output)).toEqual(['openapi.json']);
    expect(spec.openapi).toBe('3.1.0');
  });

  it('stamps the project id and IPS version', () => {
    expect(spec.info.title).toContain('proj_golden');
    expect(spec.info.version).toBe('v1');
    expect(spec.servers[0].url).toBe('https://api.instantmockapi.dev/p/proj_golden');
  });

  it('documents ONLY the selected methods', () => {
    const collection = spec.paths['/blogpost'];
    const item = spec.paths['/blogpost/{recordId}'];

    expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
    expect(item.get).toBeDefined();
    expect(item.put).toBeDefined();
    expect(item.delete).toBeDefined();
    expect(item.patch).toBeUndefined(); // PATCH not selected in the fixture
  });

  it('builds the entity schema from the IPS (nested, enums, required)', () => {
    const schema = spec.components.schemas.BlogPost;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('id');
    expect(schema.required).not.toContain('rating');
    expect(schema.properties.status.enum).toEqual(['draft', 'published', 'archived']);
    // OpenAPI 3.1: optional fields express nullability as a ["type","null"] union
    // (the removed `nullable` keyword), so keywords (optional) is an array|null.
    expect(schema.properties.metadata.properties.keywords.type).toEqual(['array', 'null']);
    expect(schema.properties.tags.items.properties.label.type).toBe('string');
  });

  it('uses the 3.1 null-union for optional fields instead of the removed `nullable`', () => {
    const schema = spec.components.schemas.BlogPost;
    // rating is optional → union type; required fields stay a plain string type
    expect(schema.properties.rating.type).toEqual(['number', 'null']);
    expect(schema.properties.rating.nullable).toBeUndefined();
    expect(schema.properties.id.type).toBe('string');
    expect(schema.properties.id.nullable).toBeUndefined();
  });

  it("embeds Worker D's example records as request/response examples", () => {
    const created = spec.paths['/blogpost'].post.requestBody.content['application/json'];
    expect(created.example).toEqual(examples['blogpost']?.[0]);

    const list = spec.paths['/blogpost'].get.responses['200'].content['application/json'];
    expect(list.example).toEqual(examples['blogpost']);
  });

  it('exposes the uniform error envelope schema', () => {
    expect(spec.components.schemas.Error.properties.error.required).toEqual(['code', 'message']);
    expect(spec.paths['/blogpost/{recordId}'].get.responses['404']).toBeDefined();
  });

  it('is deterministic', () => {
    expect(generateOpenAPI(goldenFixtureIPS, examples)).toEqual(output);
  });

  it('produces no paths when no methods are selected', () => {
    const none = generateOpenAPI(
      {
        ...goldenFixtureIPS,
        generationConfig: { ...goldenFixtureIPS.generationConfig, methods: [] },
      },
      examples,
    );
    const emptySpec = JSON.parse(none['openapi.json'] ?? '{}');
    expect(emptySpec.paths).toEqual({});
    // Schemas still documented for reference
    expect(emptySpec.components.schemas.BlogPost).toBeDefined();
  });
});

describe('generatePostmanCollection (Worker E)', () => {
  const output = generatePostmanCollection(goldenFixtureIPS, examples);
  const collection = JSON.parse(output['postman_collection.json'] ?? '{}');

  it('emits a single postman_collection.json file with v2.1 schema', () => {
    expect(Object.keys(output)).toEqual(['postman_collection.json']);
    expect(collection.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
  });

  it('creates one folder per entity with requests for selected methods only', () => {
    expect(collection.item).toHaveLength(1);
    const folder = collection.item[0];
    expect(folder.name).toBe('BlogPost');
    const names = folder.item.map((r: { name: string }) => r.name);
    expect(names).toEqual([
      'List BlogPost',
      'Get BlogPost by id',
      'Create BlogPost',
      'Replace BlogPost',
      'Delete BlogPost',
    ]); // no "Update BlogPost" — PATCH not selected
  });

  it('uses the hosted base URL variable and example bodies', () => {
    const baseUrl = collection.variable.find((v: { key: string }) => v.key === 'baseUrl');
    expect(baseUrl.value).toBe('https://api.instantmockapi.dev/p/proj_golden');

    const create = collection.item[0].item.find(
      (r: { name: string }) => r.name === 'Create BlogPost',
    );
    expect(JSON.parse(create.request.body.raw)).toEqual(examples['blogpost']?.[0]);
    expect(create.request.url.raw).toBe('{{baseUrl}}/blogpost');
  });

  it('is deterministic', () => {
    expect(generatePostmanCollection(goldenFixtureIPS, examples)).toEqual(output);
  });
});

describe('query layer documentation (doc 19 §Phase 4)', () => {
  const withFeatures = (features: Partial<QueryFeatures>) => ({
    ...materializeRelations(goldenRelationsIPS),
    generationConfig: {
      ...goldenRelationsIPS.generationConfig,
      features: { ...NO_QUERY_FEATURES, ...features },
    },
  });

  const listOperation = (features: Partial<QueryFeatures>) => {
    const spec = JSON.parse(
      generateOpenAPI(withFeatures(features))['openapi.json'] ?? '{}',
    );
    return spec.paths['/student'].get;
  };

  const parameterNames = (features: Partial<QueryFeatures>): string[] =>
    listOperation(features).parameters.map((p: { name: string }) => p.name);

  it('documents only pagination when nothing is enabled', () => {
    // A project generated before the query layer must keep exactly the spec it
    // had, or every committed client contract would show a spurious diff.
    expect(parameterNames({})).toEqual(['page', 'limit']);
  });

  it('adds one parameter per enabled feature', () => {
    expect(parameterNames({ search: true })).toEqual(['page', 'limit', 'search']);
    expect(parameterNames({ sort: true })).toEqual(['page', 'limit', 'sort']);
    expect(parameterNames({ include: true })).toEqual(['page', 'limit', 'include']);
  });

  it('documents one parameter per filterable field, not one per operator pair', () => {
    // Seven operators across a wide entity would bury the useful parameters, so
    // the suffix grammar lives in the descriptions instead.
    const names = parameterNames({ filter: true });
    expect(names).toEqual(['page', 'limit', 'id', 'name', 'enrolledAt', 'classroomId']);
    const filter = listOperation({ filter: true }).parameters.find(
      (p: { name: string }) => p.name === 'name',
    );
    expect(filter.description).toContain('name_gte');
    expect(filter.description).toContain('name_like');
  });

  it('types a filter parameter from its field, for tooling input widgets', () => {
    const parameters = listOperation({ filter: true }).parameters;
    const byName = (name: string) =>
      parameters.find((p: { name: string }) => p.name === name).schema;
    expect(byName('classroomId')).toEqual({ type: 'integer' });
    expect(byName('name')).toEqual({ type: 'string' });
  });

  it('names the searchable and sortable fields in the parameter descriptions', () => {
    const search = listOperation({ search: true }).parameters.find(
      (p: { name: string }) => p.name === 'search',
    );
    expect(search.description).toContain('name');
    const sort = listOperation({ sort: true }).parameters.find(
      (p: { name: string }) => p.name === 'sort',
    );
    expect(sort.description).toContain('classroomId');
    expect(sort.description).toContain('descending');
  });

  it('lists the includable relations in the include description', () => {
    const include = listOperation({ include: true }).parameters.find(
      (p: { name: string }) => p.name === 'include',
    );
    expect(include.description).toContain('classroom');
  });

  it('documents include on the single-record operation only', () => {
    const spec = JSON.parse(
      generateOpenAPI(withFeatures({ include: true, filter: true }))['openapi.json'] ?? '{}',
    );
    const item = spec.paths['/student/{recordId}'].get;
    expect(item.parameters.map((p: { name: string }) => p.name)).toEqual(['include']);
  });

  it('omits query parameters from the single-record operation when relations are off', () => {
    const spec = JSON.parse(
      generateOpenAPI(withFeatures({ filter: true, sort: true }))['openapi.json'] ?? '{}',
    );
    expect(spec.paths['/student/{recordId}'].get).not.toHaveProperty('parameters');
  });

  it('explains the filter grammar and the include depth in the spec description', () => {
    const bare = JSON.parse(generateOpenAPI(withFeatures({}))['openapi.json'] ?? '{}');
    expect(bare.info.description).not.toContain('operator suffixes');

    const rich = JSON.parse(
      generateOpenAPI(withFeatures({ filter: true, include: true }))['openapi.json'] ?? '{}',
    );
    expect(rich.info.description).toContain('_gte');
    expect(rich.info.description).toContain('rejected with 400');
    expect(rich.info.description).toContain('nested includes are not supported');
  });

  it('offers the enabled parameters in Postman, disabled so they do not fire', () => {
    const collection = JSON.parse(
      generatePostmanCollection(withFeatures({ search: true, sort: true, include: true }))[
        'postman_collection.json'
      ] ?? '{}',
    );
    const student = collection.item.find((f: { name: string }) => f.name === 'Student');
    const list = student.item.find((r: { name: string }) => r.name === 'List Student');
    const query = list.request.url.query as { key: string; disabled?: boolean }[];
    expect(query.filter((entry) => !entry.disabled).map((entry) => entry.key)).toEqual([
      'page',
      'limit',
    ]);
    expect(query.filter((entry) => entry.disabled).map((entry) => entry.key)).toEqual([
      'search',
      'sort',
      'include',
    ]);
  });

  it('keeps the Postman raw URL to the parameters that will actually be sent', () => {
    const collection = JSON.parse(
      generatePostmanCollection(withFeatures({ search: true }))['postman_collection.json'] ?? '{}',
    );
    const student = collection.item.find((f: { name: string }) => f.name === 'Student');
    const list = student.item.find((r: { name: string }) => r.name === 'List Student');
    expect(list.request.url.raw).toBe('{{baseUrl}}/student?page=1&limit=20');
  });

  it('leaves the Postman List request unchanged when nothing is enabled', () => {
    const collection = JSON.parse(
      generatePostmanCollection(withFeatures({}))['postman_collection.json'] ?? '{}',
    );
    const student = collection.item.find((f: { name: string }) => f.name === 'Student');
    const list = student.item.find((r: { name: string }) => r.name === 'List Student');
    expect(list.request.url.query).toEqual([
      { key: 'page', value: '1' },
      { key: 'limit', value: '20' },
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
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
    expect(spec.openapi).toBe('3.0.3');
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
    expect(schema.properties.metadata.properties.keywords.type).toBe('array');
    expect(schema.properties.tags.items.properties.label.type).toBe('string');
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

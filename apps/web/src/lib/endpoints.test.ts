import { describe, it, expect } from 'vitest';
import {
  buildSnippet,
  countEndpoints,
  endpointUrl,
  entityEndpoints,
  exampleBody,
  exampleQuery,
  projectEndpoints,
  pythonLiteral,
  type EndpointRow,
  type IpsEntity,
  type IpsField,
} from './endpoints';

function field(name: string, type = 'string', extra: Partial<IpsField> = {}): IpsField {
  return { name, type, required: true, children: [], ...extra };
}

const student: IpsEntity = {
  name: 'Student',
  identity: { field: 'id', style: 'int' },
  fields: [
    field('id', 'integer', { meta: { identity: true, readOnly: true } }),
    field('name'),
    field('enrolledAt', 'date'),
    field('classroomId', 'integer', { meta: { reference: true } }),
  ],
  relations: [{ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }],
};

const ALL: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

describe('entityEndpoints', () => {
  it('gives GET two rows — the collection and a single record', () => {
    const rows = entityEndpoints(student, ['GET']);
    expect(rows.map((row) => `${row.method} ${row.path}`)).toEqual([
      'GET /student',
      'GET /student/{id}',
    ]);
    expect(rows.map((row) => row.target)).toEqual(['collection', 'item']);
  });

  it('attaches each write method to the one URL shape that accepts it', () => {
    // The runtime answers 405 on the other shape, so listing both would document
    // an endpoint that does not exist.
    const rows = entityEndpoints(student, ALL);
    const shape = (method: string) =>
      rows.filter((row) => row.method === method).map((row) => row.target);
    expect(shape('POST')).toEqual(['collection']);
    expect(shape('PUT')).toEqual(['item']);
    expect(shape('PATCH')).toEqual(['item']);
    expect(shape('DELETE')).toEqual(['item']);
  });

  it('emits nothing for a method that was not selected', () => {
    const rows = entityEndpoints(student, ['GET', 'POST']);
    expect(rows.some((row) => row.method === 'DELETE')).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it('routes on the lowercased entity name and its declared identity field', () => {
    const custom: IpsEntity = {
      ...student,
      name: 'Course',
      identity: { field: 'code', style: 'uuid' },
    };
    expect(entityEndpoints(custom, ['GET'])[1]?.path).toBe('/course/{code}');
  });

  it('falls back to id when an entity declares no identity', () => {
    const bare: IpsEntity = { name: 'Legacy', fields: [] };
    expect(entityEndpoints(bare, ['GET'])[1]?.path).toBe('/legacy/{id}');
  });
});

describe('projectEndpoints', () => {
  const classroom: IpsEntity = {
    name: 'Classroom',
    identity: { field: 'id', style: 'int' },
    fields: [field('name')],
  };

  it('leads with the discovery document', () => {
    const rows = projectEndpoints([student], ALL);
    expect(rows[0]).toMatchObject({ method: 'GET', path: '', target: 'index' });
  });

  it('includes the index even when no methods are selected', () => {
    // The base URL answers with the entity catalogue regardless of method
    // selection, so it is always a real endpoint.
    expect(projectEndpoints([student], [])).toHaveLength(1);
  });

  it('counts every entity endpoint plus the index', () => {
    // 6 per entity with all methods (GET twice), plus one discovery document.
    expect(countEndpoints([student, classroom], ALL)).toBe(13);
    expect(countEndpoints([student, classroom], ['GET'])).toBe(5);
  });

  it('counts nothing but the index for a project with no entities', () => {
    expect(countEndpoints([], ALL)).toBe(1);
  });
});

describe('exampleBody', () => {
  it('omits server-assigned fields', () => {
    // Identity and readOnly fields are overwritten or rejected on write, so a
    // snippet including them would teach a request that does not work.
    const body = exampleBody(student);
    expect(body).not.toHaveProperty('id');
    expect(Object.keys(body)).toEqual(['name', 'enrolledAt', 'classroomId']);
  });

  it('keeps a foreign key, which is how a relation is attached', () => {
    expect(exampleBody(student)).toHaveProperty('classroomId', 1);
  });

  it('produces a value matching each field type', () => {
    const typed: IpsEntity = {
      name: 'Sample',
      fields: [
        field('count', 'integer'),
        field('price', 'decimal'),
        field('active', 'boolean'),
        field('at', 'date'),
        field('mail', 'email'),
        field('site', 'url'),
        field('token', 'uuid'),
        field('tier', 'enum'),
        field('label'),
      ],
    };
    expect(exampleBody(typed)).toEqual({
      count: 1,
      price: 9.99,
      active: true,
      at: '2026-01-31',
      mail: 'ada@example.com',
      site: 'https://example.com',
      token: '3f1a7c4e-0b2d-4e5f-8a91-2c6d5e4f7a8b',
      tier: 'value',
      label: 'example label',
    });
  });

  it('descends into objects and arrays', () => {
    const nested: IpsEntity = {
      name: 'Post',
      fields: [
        field('meta', 'object', { children: [field('seoTitle'), field('views', 'integer')] }),
        field('tags', 'array', { children: [field('tag')] }),
      ],
    };
    expect(exampleBody(nested)).toEqual({
      meta: { seoTitle: 'example seoTitle', views: 1 },
      tags: ['example tag'],
    });
  });

  it('emits an empty array for an array with no element definition', () => {
    const loose: IpsEntity = { name: 'X', fields: [field('items', 'array', { children: [] })] };
    expect(exampleBody(loose)).toEqual({ items: [] });
  });
});

describe('exampleQuery', () => {
  it('always demonstrates pagination', () => {
    expect(exampleQuery()).toBe('page=1&limit=20');
  });

  it('only demonstrates parameters this project accepts', () => {
    // A ?sort= in the snippet of an API with sorting off would 400 on first run.
    expect(exampleQuery({ sort: true })).toContain('sort=-id');
    expect(exampleQuery({ sort: false })).not.toContain('sort');
    expect(exampleQuery({ include: true })).toContain('include=');
  });
});

describe('endpointUrl', () => {
  const collection: EndpointRow = {
    method: 'GET',
    path: '/student',
    summary: '',
    target: 'collection',
  };
  const item: EndpointRow = {
    method: 'GET',
    path: '/student/{id}',
    summary: '',
    target: 'item',
  };

  it('joins the base URL without doubling the slash', () => {
    expect(endpointUrl('https://api.dev/p/prj_1/erp/', collection)).toBe(
      'https://api.dev/p/prj_1/erp/student',
    );
  });

  it('substitutes a record id that actually exists for an int identity', () => {
    // Seeds start at 1, so the pasted snippet returns a record instead of a 404.
    expect(endpointUrl('https://api.dev/p/x', item, { entity: student })).toBe(
      'https://api.dev/p/x/student/1',
    );
  });

  it('substitutes a uuid placeholder when the identity is a uuid', () => {
    const uuidEntity: IpsEntity = { ...student, identity: { field: 'id', style: 'uuid' } };
    expect(endpointUrl('https://api.dev/p/x', item, { entity: uuidEntity })).toContain(
      '/student/00000000-0000-4000-8000-000000000000',
    );
  });

  it('appends the query only to a collection GET', () => {
    const query = 'page=1&limit=20';
    expect(endpointUrl('https://api.dev/p/x', collection, { query })).toContain('?page=1&limit=20');
    expect(endpointUrl('https://api.dev/p/x', item, { entity: student, query })).not.toContain('?');
    const post: EndpointRow = { ...collection, method: 'POST' };
    expect(endpointUrl('https://api.dev/p/x', post, { query })).not.toContain('?');
  });

  it('renders the discovery document as the bare base URL', () => {
    const index: EndpointRow = { method: 'GET', path: '', summary: '', target: 'index' };
    expect(endpointUrl('https://api.dev/p/x', index)).toBe('https://api.dev/p/x');
  });
});

describe('buildSnippet — cURL', () => {
  const url = 'https://api.dev/p/x/student?page=1&limit=20';

  it('quotes the URL so the shell does not split on the query separator', () => {
    const snippet = buildSnippet({ language: 'curl', method: 'GET', url });
    expect(snippet).toContain(`--url '${url}'`);
  });

  it('sends a JSON body with the right header for a write', () => {
    const snippet = buildSnippet({
      language: 'curl',
      method: 'POST',
      url: 'https://api.dev/p/x/student',
      body: { name: 'Ada' },
    });
    expect(snippet).toContain('--request POST');
    expect(snippet).toContain(`--header 'Content-Type: application/json'`);
    expect(snippet).toContain('"name": "Ada"');
  });

  it('escapes an apostrophe instead of ending the quoted string early', () => {
    // A name like O'Hara would otherwise terminate the shell quoting and
    // produce a snippet that does not parse.
    const snippet = buildSnippet({
      language: 'curl',
      method: 'POST',
      url: 'https://api.dev/p/x/student',
      body: { name: "O'Hara" },
    });
    expect(snippet).toContain(`'\\''`);
    expect(snippet).not.toMatch(/--data '[^']*'[A-Za-z]/);
  });

  it('continues each option line, and ends the command cleanly', () => {
    // Only the option lines need a continuation. The pretty-printed body sits
    // inside the quoted --data argument, where its newlines are part of the
    // string rather than command breaks — so those lines carry no backslash.
    const lines = buildSnippet({
      language: 'curl',
      method: 'POST',
      url: 'https://api.dev/p/x/student',
      body: { a: 1 },
    }).split('\n');
    const optionLines = lines.filter(
      (line) => line.startsWith('curl ') || /^\s+--(url|header|request|data)\b/.test(line),
    );
    expect(optionLines.slice(0, -1).every((line) => line.endsWith('\\'))).toBe(true);
    expect(lines[lines.length - 1]?.endsWith('\\')).toBe(false);
    // The quotes around the body are balanced, so the command parses.
    expect(
      buildSnippet({
        language: 'curl',
        method: 'POST',
        url: 'https://api.dev/p/x/student',
        body: { a: 1 },
      }).split("'").length % 2,
    ).toBe(1);
  });
});

describe('buildSnippet — JavaScript', () => {
  it('omits the init object entirely for a plain GET', () => {
    const snippet = buildSnippet({
      language: 'javascript',
      method: 'GET',
      url: 'https://api.dev/p/x/student',
    });
    expect(snippet).toContain(`fetch('https://api.dev/p/x/student')`);
    expect(snippet).not.toContain('method:');
  });

  it('names the method for a bodyless non-GET', () => {
    const snippet = buildSnippet({
      language: 'javascript',
      method: 'DELETE',
      url: 'https://api.dev/p/x/student/1',
    });
    expect(snippet).toContain(`method: 'DELETE'`);
    expect(snippet).not.toContain('body:');
  });

  it('serializes a body and sets the content type', () => {
    const snippet = buildSnippet({
      language: 'javascript',
      method: 'POST',
      url: 'https://api.dev/p/x/student',
      body: { name: 'Ada' },
    });
    expect(snippet).toContain(`'Content-Type': 'application/json'`);
    expect(snippet).toContain('JSON.stringify(');
    expect(snippet).toContain('"name": "Ada"');
  });
});

describe('buildSnippet — Python', () => {
  it('calls the method-named requests helper', () => {
    expect(
      buildSnippet({ language: 'python', method: 'GET', url: 'https://api.dev/p/x/student' }),
    ).toContain(`requests.get('https://api.dev/p/x/student')`);
    expect(
      buildSnippet({ language: 'python', method: 'PATCH', url: 'https://api.dev/p/x/student/1' }),
    ).toContain('requests.patch(');
  });

  it('passes the body as a Python literal, not as JSON', () => {
    // JSON true/false/null are not Python — pasting them raises NameError.
    const snippet = buildSnippet({
      language: 'python',
      method: 'POST',
      url: 'https://api.dev/p/x/student',
      body: { active: true, deleted: false, note: null },
    });
    expect(snippet).toContain('True');
    expect(snippet).toContain('False');
    expect(snippet).toContain('None');
    expect(snippet).not.toContain('true');
    expect(snippet).not.toContain('null');
  });
});

describe('pythonLiteral', () => {
  it('maps the JSON scalars Python spells differently', () => {
    expect(pythonLiteral(true)).toBe('True');
    expect(pythonLiteral(false)).toBe('False');
    expect(pythonLiteral(null)).toBe('None');
    expect(pythonLiteral(undefined)).toBe('None');
    expect(pythonLiteral(12.5)).toBe('12.5');
  });

  it('escapes quotes and backslashes in a string', () => {
    expect(pythonLiteral("O'Hara")).toBe("'O\\'Hara'");
    expect(pythonLiteral('back\\slash')).toBe("'back\\\\slash'");
  });

  it('renders empty containers compactly', () => {
    expect(pythonLiteral([])).toBe('[]');
    expect(pythonLiteral({})).toBe('{}');
  });

  it('nests dicts and lists with growing indentation', () => {
    const rendered = pythonLiteral({ tags: ['a'], meta: { views: 1 } });
    expect(rendered).toContain("'tags': [");
    expect(rendered).toContain("'meta': {");
    expect(rendered).toContain("'views': 1");
  });
});

describe('entity path convention', () => {
  it('lowercases the entity name, matching the hosting generator', () => {
    // generateHostingConfig routes each entity at name.toLowerCase(), and the
    // runtime looks entities up by that path. This derivation is duplicated here
    // rather than imported (apps/web does not depend on the generator), so this
    // is the breadcrumb if that convention ever changes.
    const mixed: IpsEntity = { name: 'BlogPost', fields: [] };
    expect(entityEndpoints(mixed, ['GET'])[0]?.path).toBe('/blogpost');
  });

  it('builds a URL the runtime resolves for both the collection and one record', () => {
    // Appended to the hosted base URL these are /p/{publicId}/{slug}/student and
    // /p/{publicId}/{slug}/student/1 — the two shapes the runtime routes.
    const base = 'https://api.instantmockapi.dev/p/prj_7d5e9a2f1c/student-erp';
    const rows = entityEndpoints(student, ['GET']);
    expect(endpointUrl(base, rows[0]!, { entity: student })).toBe(`${base}/student`);
    expect(endpointUrl(base, rows[1]!, { entity: student })).toBe(`${base}/student/1`);
  });
});

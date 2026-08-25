/**
 * The endpoint surface a generated project exposes, and the request snippets
 * that call it.
 *
 * Derived from the stored IPS rather than fetched: the hosted API has no
 * "list my endpoints" call beyond its discovery document, and the IPS already
 * says exactly which entities exist and which methods were selected. Keeping it
 * pure means the Explore screen and the snippet panel agree by construction, and
 * both can be tested without a network.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Shape of the stored IPS the screens actually read. */
export interface IpsField {
  name: string;
  type: string;
  required: boolean;
  children?: IpsField[];
  meta?: { identity?: boolean; readOnly?: boolean; reference?: boolean };
}

export interface IpsRelation {
  name: string;
  kind: string;
  target: string;
}

export interface IpsEntity {
  name: string;
  fields: IpsField[];
  relations?: IpsRelation[];
  identity?: { field: string; style: 'int' | 'uuid' };
}

export interface EndpointRow {
  method: HttpMethod;
  /** Path relative to the project's hosted base URL, e.g. `/student/{id}`. */
  path: string;
  summary: string;
  /** Which URL shape this is — the snippet needs to know if an id is required. */
  target: 'index' | 'collection' | 'item';
  /** Entity this belongs to; absent for the project discovery document. */
  entity?: string;
}

const ENTITY_PATH = (entity: IpsEntity): string => entity.name.toLowerCase();

function identityField(entity: IpsEntity): string {
  return entity.identity?.field ?? 'id';
}

/**
 * Endpoints one entity exposes under the selected methods.
 *
 * `GET` is the only method producing two rows: it answers on both the
 * collection and a single record, and they are genuinely different endpoints to
 * a reader. Every write method attaches to exactly one shape — which is also
 * what the runtime enforces, answering 405 with a message naming the other.
 */
export function entityEndpoints(entity: IpsEntity, methods: readonly string[]): EndpointRow[] {
  const path = `/${ENTITY_PATH(entity)}`;
  const id = `{${identityField(entity)}}`;
  const rows: EndpointRow[] = [];
  const has = (method: HttpMethod): boolean => methods.includes(method);

  if (has('GET')) {
    rows.push({
      method: 'GET',
      path,
      summary: `List ${entity.name} records`,
      target: 'collection',
      entity: entity.name,
    });
  }
  if (has('POST')) {
    rows.push({
      method: 'POST',
      path,
      summary: `Create a ${entity.name}`,
      target: 'collection',
      entity: entity.name,
    });
  }
  if (has('GET')) {
    rows.push({
      method: 'GET',
      path: `${path}/${id}`,
      summary: `Fetch one ${entity.name}`,
      target: 'item',
      entity: entity.name,
    });
  }
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    if (has(method)) {
      rows.push({
        method,
        path: `${path}/${id}`,
        summary:
          method === 'PUT'
            ? `Replace a ${entity.name}`
            : method === 'PATCH'
              ? `Update a ${entity.name}`
              : `Delete a ${entity.name}`,
        target: 'item',
        entity: entity.name,
      });
    }
  }
  return rows;
}

/**
 * Every endpoint in the project, discovery document first.
 *
 * The index is included because it is a real, always-available endpoint — the
 * base URL answers with the entity catalogue regardless of which methods were
 * selected, and it is the first thing worth trying.
 */
export function projectEndpoints(
  entities: readonly IpsEntity[],
  methods: readonly string[],
): EndpointRow[] {
  const rows: EndpointRow[] = [
    { method: 'GET', path: '', summary: 'Discovery document', target: 'index' },
  ];
  for (const entity of entities) {
    rows.push(...entityEndpoints(entity, methods));
  }
  return rows;
}

/** Total endpoint count — the "Total APIs" figure on the Ready screen. */
export function countEndpoints(entities: readonly IpsEntity[], methods: readonly string[]): number {
  return projectEndpoints(entities, methods).length;
}

/**
 * A plausible request body for an entity.
 *
 * Server-assigned fields are omitted: identity and anything marked `readOnly`
 * are rejected or overwritten on write, so including them in a copy-pasteable
 * snippet would teach the wrong request. Foreign keys stay — they are how a
 * related record is attached, and leaving them out would make the example fail
 * validation on a required relation.
 */
export function exampleBody(entity: IpsEntity): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of entity.fields) {
    if (field.meta?.identity || field.meta?.readOnly) {
      continue;
    }
    body[field.name] = exampleValue(field);
  }
  return body;
}

function exampleValue(field: IpsField): unknown {
  switch (field.type) {
    case 'integer':
      return 1;
    case 'number':
    case 'decimal':
      return 9.99;
    case 'boolean':
      return true;
    case 'date':
      return '2026-01-31';
    case 'email':
      return 'ada@example.com';
    case 'url':
      return 'https://example.com';
    case 'uuid':
      return '3f1a7c4e-0b2d-4e5f-8a91-2c6d5e4f7a8b';
    case 'enum':
      return 'value';
    case 'object':
      return Object.fromEntries(
        (field.children ?? []).map((child) => [child.name, exampleValue(child)]),
      );
    case 'array': {
      const element = field.children?.[0];
      return element ? [exampleValue(element)] : [];
    }
    default:
      return `example ${field.name}`;
  }
}

/** Query string a list endpoint is worth demonstrating with. */
export function exampleQuery(features?: {
  search?: boolean;
  filter?: boolean;
  sort?: boolean;
  include?: boolean;
}): string {
  const parts = ['page=1', 'limit=20'];
  // Only what this project actually accepts: a snippet showing `?sort=` against
  // an API with sorting switched off would 400 on the first run.
  if (features?.sort) {
    parts.push('sort=-id');
  }
  if (features?.include) {
    parts.push('include=');
  }
  return parts.join('&');
}

export type SnippetLanguage = 'curl' | 'javascript' | 'python';

export const SNIPPET_LANGUAGES: { id: SnippetLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
];

export interface SnippetInput {
  language: SnippetLanguage;
  method: HttpMethod;
  /** Fully-qualified URL, id placeholder already substituted. */
  url: string;
  /** Present for write methods only. */
  body?: Record<string, unknown> | undefined;
}

/**
 * Single-quote a value for a POSIX shell.
 *
 * A URL carrying a query string must be quoted or the shell eats the `&`, and an
 * apostrophe inside a body would end the quoting early — so the standard
 * close/escape/reopen dance rather than a bare wrap.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSnippet({ language, method, url, body }: SnippetInput): string {
  const json = body ? JSON.stringify(body, null, 2) : null;

  if (language === 'curl') {
    const lines = [`curl --request ${method} \\`, `  --url ${shellQuote(url)}`];
    if (json) {
      lines[lines.length - 1] += ' \\';
      lines.push(`  --header 'Content-Type: application/json' \\`);
      lines.push(`  --data ${shellQuote(json)}`);
    }
    return lines.join('\n');
  }

  if (language === 'javascript') {
    const init = json
      ? `, {\n  method: '${method}',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify(${indent(json, 2)}),\n}`
      : method === 'GET'
        ? ''
        : `, { method: '${method}' }`;
    return [
      `const response = await fetch('${url}'${init});`,
      `const data = await response.json();`,
      `console.log(data);`,
    ].join('\n');
  }

  // Python
  const call = json
    ? `requests.${method.toLowerCase()}(\n    '${url}',\n    json=${pythonLiteral(body ?? {}, 1)},\n)`
    : `requests.${method.toLowerCase()}('${url}')`;
  return [`import requests`, ``, `response = ${call}`, `print(response.json())`].join('\n');
}

/** Re-indent a JSON block so it sits correctly inside a snippet. */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : pad + line))
    .join('\n');
}

/**
 * Render a value as a Python literal.
 *
 * `JSON.stringify` almost works, but `true`/`false`/`null` are not Python —
 * pasting them raises `NameError`, which is exactly the kind of broken snippet
 * that costs trust.
 */
export function pythonLiteral(value: unknown, depth = 0): string {
  const pad = '    '.repeat(depth + 1);
  const closePad = '    '.repeat(depth);

  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map((item) => `${pad}${pythonLiteral(item, depth + 1)}`);
    return `[\n${items.join(',\n')},\n${closePad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return '{}';
  }
  const rendered = entries.map(
    ([key, item]) => `${pad}'${key}': ${pythonLiteral(item, depth + 1)}`,
  );
  return `{\n${rendered.join(',\n')},\n${closePad}}`;
}

/**
 * The URL a snippet should call for one endpoint.
 *
 * The id placeholder is replaced with a concrete value so the snippet runs as
 * pasted: `int` identities seed from 1, so `/student/1` exists in a fresh
 * project, whereas `/student/{id}` would 404 and read like a broken example.
 */
export function endpointUrl(
  baseUrl: string,
  endpoint: EndpointRow,
  options: { entity?: IpsEntity; query?: string } = {},
): string {
  const base = baseUrl.replace(/\/+$/, '');
  let path = endpoint.path;

  if (endpoint.target === 'item') {
    const style = options.entity?.identity?.style ?? 'uuid';
    const sample = style === 'int' ? '1' : '00000000-0000-4000-8000-000000000000';
    path = path.replace(/\{[^}]+\}/, sample);
  }

  const query = endpoint.target === 'collection' && endpoint.method === 'GET' ? options.query : '';
  return `${base}${path}${query ? `?${query}` : ''}`;
}

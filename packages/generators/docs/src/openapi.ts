/**
 * OpenAPI 3.1 generator (Worker E, doc 09 §4).
 *
 * Documents ONLY the selected methods (doc 08 §9 conventions for the hosted
 * mock API); example bodies come from Worker D's example records so docs and
 * the live API always agree.
 */

import { entitySlug, HTTP_METHODS, hostedUrl, type HttpMethod } from '@instantmockapi/shared';
import {
  FILTER_OPERATORS,
  authEnabled,
  entityAuth,
  entityQueryFields,
  projectAuth,
  queryFeatures,
  type Entity,
  type InternalProjectSchema,
  type QueryFeatures,
} from '@instantmockapi/ips';
import {
  authPaths,
  authSchemas,
  authTag,
  entityAuthNote,
  protectedSecurity,
  securitySchemes,
} from './openapi-auth.js';
import { entitySchema, type OpenAPISchemaNode } from './schema-mapper.js';
import { exampleList, firstExample, type EntityExamples } from './examples.js';

const ERROR_SCHEMA: OpenAPISchemaNode = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, issue: { type: 'string' } },
          },
        },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

function ref(entity: Entity): OpenAPISchemaNode {
  return { $ref: `#/components/schemas/${entity.name}` };
}

function jsonContent(schema: OpenAPISchemaNode, example?: unknown): OpenAPISchemaNode {
  const content: OpenAPISchemaNode = { schema };
  if (example !== undefined) {
    content['example'] = example;
  }
  return { 'application/json': content };
}

function errorResponse(description: string): OpenAPISchemaNode {
  return { description, content: jsonContent({ $ref: '#/components/schemas/Error' }) };
}

const PAGINATION_PARAMETERS: OpenAPISchemaNode[] = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, default: 20 } },
];

/**
 * Query parameters for a list operation, derived from the same helper the
 * runtime validates against — so the documented surface and the accepted
 * surface are the same set by construction, not by two matching edits.
 *
 * One parameter is emitted per filterable field rather than one per
 * field-and-operator pair: with seven operators a ten-field entity would
 * otherwise carry eighty parameters, which buries the useful ones. The suffix
 * grammar goes in the operation description instead.
 */
function listParameters(entity: Entity, features: QueryFeatures): OpenAPISchemaNode[] {
  const parameters = [...PAGINATION_PARAMETERS];
  const fields = entityQueryFields(entity);

  if (features.search && fields.searchable.length > 0) {
    parameters.push({
      name: 'search',
      in: 'query',
      description: `Case-insensitive substring match across: ${fields.searchable.join(', ')}.`,
      schema: { type: 'string' },
    });
  }

  if (features.sort && fields.sortable.length > 0) {
    parameters.push({
      name: 'sort',
      in: 'query',
      description:
        `Comma-separated field list; prefix a field with '-' to sort descending. ` +
        `Sortable: ${fields.sortable.join(', ')}.`,
      schema: { type: 'string' },
    });
  }

  if (features.include && fields.includable.length > 0) {
    parameters.push(includeParameter(fields.includable));
  }

  if (features.filter) {
    for (const field of entity.fields) {
      if (!fields.filterable.includes(field.name)) {
        continue;
      }
      parameters.push({
        name: field.name,
        in: 'query',
        description:
          `Filter by ${field.name}. Also accepts the suffixed forms ` +
          FILTER_OPERATORS.map((operator) => `${field.name}_${operator}`).join(', ') +
          '.',
        schema: filterSchema(field.type),
      });
    }
  }

  return parameters;
}

function includeParameter(includable: readonly string[]): OpenAPISchemaNode {
  return {
    name: 'include',
    in: 'query',
    description: `Comma-separated relations to expand: ${includable.join(', ')}.`,
    schema: { type: 'string' },
  };
}

/**
 * Query values always arrive as text, so these types are a hint for tooling
 * input widgets rather than a constraint the runtime enforces.
 */
function filterSchema(type: Entity['fields'][number]['type']): OpenAPISchemaNode {
  switch (type) {
    case 'integer':
      return { type: 'integer' };
    case 'number':
    case 'decimal':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return { type: 'string' };
  }
}

/** Selected methods in canonical HTTP_METHODS order. */
function selectedMethods(ips: InternalProjectSchema): HttpMethod[] {
  const chosen = new Set(ips.generationConfig.methods);
  return HTTP_METHODS.filter((m) => chosen.has(m));
}

/** Where the hosted API lives. Options keep the generator pure — no env reads. */
export interface DocsOptions {
  /** Hosted base URL without the project segment. */
  baseUrl?: string;
}

export const DEFAULT_HOSTED_BASE_URL = 'https://api.instantmockapi.dev/p';

/**
 * Canonical server URL for a project: the pretty `{publicId}/{slug}` form when
 * the IPS carries addressing, else the legacy project-id form. Exactly one entry
 * is emitted — a second `servers[]` would leave codegen tooling guessing which
 * to use, so the legacy form is documented in prose instead.
 */
export function serverUrl(ips: InternalProjectSchema, options: DocsOptions = {}): string {
  return hostedUrl(options.baseUrl ?? DEFAULT_HOSTED_BASE_URL, {
    projectId: ips.projectId,
    publicId: ips.publicId,
    slug: ips.slug,
  });
}

/**
 * Spec-level prose. The query-layer sentence is only added when something is
 * enabled, so a project without it keeps the description it always had.
 */
function describeApi(features: QueryFeatures): string {
  const base =
    'Generated hosted mock API documentation. Unselected methods return 405; ' +
    'invalid writes return 422 with field-level errors.';
  const notes: string[] = [];
  if (features.filter) {
    notes.push(
      `Filters accept the operator suffixes ${FILTER_OPERATORS.map((o) => '_' + o).join(', ')} ` +
        "(for example 'price_gte=10', 'city_in=Paris,Berlin', 'name_like=ada'); " +
        "'field=null' matches records where the field is absent. " +
        'An unknown filter parameter is rejected with 400 rather than ignored.',
    );
  }
  if (features.include) {
    notes.push('Relations expand one level deep; nested includes are not supported.');
  }
  return notes.length > 0 ? `${base} ${notes.join(' ')}` : base;
}

export function generateOpenAPI(
  ips: InternalProjectSchema,
  examples: EntityExamples = {},
  options: DocsOptions = {},
): Record<string, string> {
  const methods = selectedMethods(ips);
  const features = queryFeatures(ips.generationConfig);
  const paths: OpenAPISchemaNode = {};
  const schemas: OpenAPISchemaNode = { Error: ERROR_SCHEMA };

  const tags: OpenAPISchemaNode[] = [];

  /*
   * Authentication (Phase 3 §19), resolved once here.
   *
   * `entityAuth` is the only reader of the mode, exactly as in the hosting
   * generator — so the documented `security` and the runtime's gate come from
   * one function and cannot disagree about which entities are protected.
   */
  const auth = projectAuth(ips);
  const authOn = authEnabled(auth);
  const secured = authOn ? protectedSecurity(auth) : [];

  for (const entity of ips.entities) {
    const schema = entitySchema(entity);
    const entityProtected = authOn && entityAuth(auth, entity) === 'PROTECTED';
    /*
     * §19 asks that PUBLIC/PROTECTED be *clearly shown* per entity, so the note
     * joins the tag description a human reads in Swagger UI. Appended to the
     * author's own description rather than replacing it, and a tag is emitted
     * for an undescribed entity too once auth is on — otherwise the entities
     * without descriptions would be the ones whose protection is invisible.
     */
    const authNote = authOn ? entityAuthNote(entityProtected) : '';
    const description = [entity.description, authNote].filter((part) => part).join(' ');

    if (entity.description) {
      schema['description'] = entity.description;
    }
    if (description !== '') {
      // A described entity also becomes a described tag, which is what Swagger
      // UI renders above its operation group.
      tags.push({ name: entity.name, description });
    }
    schemas[entity.name] = schema;

    // Spread onto every operation of this entity. Per-operation rather than
    // document-level, so an operation that declared nothing cannot silently
    // inherit protection it does not have — see `openapi-auth.ts`.
    const security: OpenAPISchemaNode = entityProtected ? { security: secured } : {};
    const unauthorized = entityProtected
      ? { '401': errorResponse('Missing or invalid access token') }
      : {};

    const path = `/${entitySlug(entity)}`;
    const itemPath = `${path}/{recordId}`;
    const example = firstExample(examples, entity.name);
    const listExample = exampleList(examples, entity.name);
    const collection: OpenAPISchemaNode = {};
    const item: OpenAPISchemaNode = {};

    if (methods.includes('GET')) {
      collection['get'] = {
        operationId: `list${entity.name}`,
        summary: `List ${entity.name} records`,
        tags: [entity.name],
        ...security,
        parameters: listParameters(entity, features),
        responses: {
          ...unauthorized,
          '200': {
            description: `Paginated ${entity.name} records`,
            content: jsonContent({ type: 'array', items: ref(entity) }, listExample),
          },
        },
      };
      const includable = entityQueryFields(entity).includable;
      item['get'] = {
        operationId: `get${entity.name}`,
        summary: `Fetch a single ${entity.name}`,
        tags: [entity.name],
        ...security,
        // Only include= is meaningful on one record, and only when relations
        // are switched on.
        ...(features.include && includable.length > 0
          ? { parameters: [includeParameter(includable)] }
          : {}),
        responses: {
          ...unauthorized,
          '200': { description: `The ${entity.name}`, content: jsonContent(ref(entity), example) },
          '404': errorResponse('Record not found'),
        },
      };
    }

    if (methods.includes('POST')) {
      collection['post'] = {
        operationId: `create${entity.name}`,
        summary: `Create a ${entity.name}`,
        tags: [entity.name],
        ...security,
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
          ...unauthorized,
          '201': { description: 'Created', content: jsonContent(ref(entity), example) },
          '422': errorResponse('Validation failed against the generated rules'),
        },
      };
    }

    if (methods.includes('PUT')) {
      item['put'] = {
        operationId: `replace${entity.name}`,
        summary: `Replace a ${entity.name}`,
        tags: [entity.name],
        ...security,
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
          ...unauthorized,
          '200': { description: 'Replaced', content: jsonContent(ref(entity), example) },
          '404': errorResponse('Record not found'),
          '422': errorResponse('Validation failed against the generated rules'),
        },
      };
    }

    if (methods.includes('PATCH')) {
      item['patch'] = {
        operationId: `update${entity.name}`,
        summary: `Update a ${entity.name}`,
        tags: [entity.name],
        ...security,
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
          ...unauthorized,
          '200': { description: 'Updated', content: jsonContent(ref(entity), example) },
          '404': errorResponse('Record not found'),
          '422': errorResponse('Validation failed against the generated rules'),
        },
      };
    }

    if (methods.includes('DELETE')) {
      item['delete'] = {
        operationId: `delete${entity.name}`,
        summary: `Delete a ${entity.name}`,
        tags: [entity.name],
        ...security,
        responses: {
          ...unauthorized,
          '204': { description: 'Deleted' },
          '404': errorResponse('Record not found'),
        },
      };
    }

    if (Object.keys(collection).length > 0) {
      paths[path] = collection;
    }
    if (Object.keys(item).length > 0) {
      item['parameters'] = [
        { name: 'recordId', in: 'path', required: true, schema: { type: 'string' } },
      ];
      paths[itemPath] = item;
    }
  }

  /*
   * The Auth API's own paths, added after the entities so they appear last in
   * the document — and so a reserved-name collision is impossible by the time
   * we get here: `validateIPS` rejects an entity named `Me` while
   * authentication is on, which is what stops this overwriting an entity path.
   */
  if (authOn) {
    Object.assign(paths, authPaths(auth));
    Object.assign(schemas, authSchemas(auth));
    tags.unshift(authTag(auth));
  }

  const spec: OpenAPISchemaNode = {
    openapi: '3.1.0',
    info: {
      title: `InstantMockAPI — project ${ips.projectId}`,
      version: `v${ips.version}`,
      description: describeApi(features),
    },
    servers: [{ url: serverUrl(ips, options) }],
    // Omitted entirely when nothing is described, so an existing spec gains no
    // empty array.
    ...(tags.length > 0 ? { tags } : {}),
    paths,
    components: {
      schemas: schemas,
      // Only when there is an Auth API. A project with authentication off keeps
      // the exact spec it had before Phase 3 (§26).
      ...(authOn ? { securitySchemes: securitySchemes(auth) } : {}),
    },
  };

  return { 'openapi.json': JSON.stringify(spec, null, 2) };
}

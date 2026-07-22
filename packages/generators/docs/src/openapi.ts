/**
 * OpenAPI 3.1 generator (Worker E, doc 09 §4).
 *
 * Documents ONLY the selected methods (doc 08 §9 conventions for the hosted
 * mock API); example bodies come from Worker D's example records so docs and
 * the live API always agree.
 */

import { HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
import type { Entity, InternalProjectSchema } from '@instantmockapi/ips';
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

/** Selected methods in canonical HTTP_METHODS order. */
function selectedMethods(ips: InternalProjectSchema): HttpMethod[] {
  const chosen = new Set(ips.generationConfig.methods);
  return HTTP_METHODS.filter((m) => chosen.has(m));
}

export function generateOpenAPI(
  ips: InternalProjectSchema,
  examples: EntityExamples = {},
): Record<string, string> {
  const methods = selectedMethods(ips);
  const paths: OpenAPISchemaNode = {};
  const schemas: OpenAPISchemaNode = { Error: ERROR_SCHEMA };

  for (const entity of ips.entities) {
    schemas[entity.name] = entitySchema(entity);

    const path = `/${entity.name.toLowerCase()}`;
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
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, default: 20 } },
        ],
        responses: {
          '200': {
            description: `Paginated ${entity.name} records`,
            content: jsonContent({ type: 'array', items: ref(entity) }, listExample),
          },
        },
      };
      item['get'] = {
        operationId: `get${entity.name}`,
        summary: `Fetch a single ${entity.name}`,
        tags: [entity.name],
        responses: {
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
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
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
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
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
        requestBody: { required: true, content: jsonContent(ref(entity), example) },
        responses: {
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
        responses: {
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

  const spec: OpenAPISchemaNode = {
    openapi: '3.1.0',
    info: {
      title: `InstantMockAPI — project ${ips.projectId}`,
      version: `v${ips.version}`,
      description:
        'Generated hosted mock API documentation. Unselected methods return 405; invalid writes return 422 with field-level errors.',
    },
    servers: [{ url: `https://api.instantmockapi.dev/p/${ips.projectId}` }],
    paths,
    components: { schemas: schemas },
  };

  return { 'openapi.json': JSON.stringify(spec, null, 2) };
}

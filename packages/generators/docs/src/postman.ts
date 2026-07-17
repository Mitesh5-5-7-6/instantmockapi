/**
 * Postman collection v2.1 generator (Worker E, doc 09 §4).
 * One folder per entity; only selected methods get requests; bodies come
 * from Worker D's example records.
 */

import { HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
import type { InternalProjectSchema } from '@instantmockapi/ips';
import { firstExample, type EntityExamples } from './examples.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PostmanNode {
  [key: string]: any;
}

function url(pathSegments: string[], query?: Record<string, string>): PostmanNode {
  const node: PostmanNode = {
    raw:
      `{{baseUrl}}/${pathSegments.join('/')}` +
      (query
        ? `?${Object.entries(query)
            .map(([k, v]) => `${k}=${v}`)
            .join('&')}`
        : ''),
    host: ['{{baseUrl}}'],
    path: pathSegments,
  };
  if (query) {
    node['query'] = Object.entries(query).map(([key, value]) => ({ key, value }));
  }
  return node;
}

function jsonBody(example: Record<string, unknown>): PostmanNode {
  return {
    mode: 'raw',
    raw: JSON.stringify(example, null, 2),
    options: { raw: { language: 'json' } },
  };
}

const JSON_HEADER = [{ key: 'Content-Type', value: 'application/json' }];

export function generatePostmanCollection(
  ips: InternalProjectSchema,
  examples: EntityExamples = {},
): Record<string, string> {
  const chosen = new Set(ips.generationConfig.methods);
  const methods = HTTP_METHODS.filter((m): m is HttpMethod => chosen.has(m));

  const folders: PostmanNode[] = [];
  for (const entity of ips.entities) {
    const entityPath = entity.name.toLowerCase();
    const example = firstExample(examples, entity.name);
    const requests: PostmanNode[] = [];

    if (methods.includes('GET')) {
      requests.push({
        name: `List ${entity.name}`,
        request: {
          method: 'GET',
          header: [],
          url: url([entityPath], { page: '1', limit: '20' }),
        },
      });
      requests.push({
        name: `Get ${entity.name} by id`,
        request: { method: 'GET', header: [], url: url([entityPath, ':recordId']) },
      });
    }
    if (methods.includes('POST')) {
      requests.push({
        name: `Create ${entity.name}`,
        request: {
          method: 'POST',
          header: JSON_HEADER,
          body: jsonBody(example),
          url: url([entityPath]),
        },
      });
    }
    if (methods.includes('PUT')) {
      requests.push({
        name: `Replace ${entity.name}`,
        request: {
          method: 'PUT',
          header: JSON_HEADER,
          body: jsonBody(example),
          url: url([entityPath, ':recordId']),
        },
      });
    }
    if (methods.includes('PATCH')) {
      requests.push({
        name: `Update ${entity.name}`,
        request: {
          method: 'PATCH',
          header: JSON_HEADER,
          body: jsonBody(example),
          url: url([entityPath, ':recordId']),
        },
      });
    }
    if (methods.includes('DELETE')) {
      requests.push({
        name: `Delete ${entity.name}`,
        request: { method: 'DELETE', header: [], url: url([entityPath, ':recordId']) },
      });
    }

    folders.push({ name: entity.name, item: requests });
  }

  const collection: PostmanNode = {
    info: {
      name: `InstantMockAPI — project ${ips.projectId} (v${ips.version})`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: `https://api.instantmockapi.dev/p/${ips.projectId}` },
      { key: 'recordId', value: '' },
    ],
    item: folders,
  };

  return { 'postman_collection.json': JSON.stringify(collection, null, 2) };
}

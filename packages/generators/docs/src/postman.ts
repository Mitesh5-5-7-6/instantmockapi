/**
 * Postman collection v2.1 generator (Worker E, doc 09 §4).
 * One folder per entity; only selected methods get requests; bodies come
 * from Worker D's example records.
 */

import { entitySlug, HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
import {
  authEnabled,
  entityAuth,
  entityQueryFields,
  projectAuth,
  queryFeatures,
  type Entity,
  type InternalProjectSchema,
  type QueryFeatures,
} from '@instantmockapi/ips';
import { firstExample, type EntityExamples } from './examples.js';
import { authFolder, authVariables, bearerHeader } from './postman-auth.js';
import { serverUrl, type DocsOptions } from './openapi.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PostmanNode {
  [key: string]: any;
}

/**
 * Query entries for the List request, disabled so they do not fire on the first
 * send but are one checkbox away in Postman.
 *
 * Pagination stays enabled, matching the request this generator has always
 * produced.
 */
function listQuery(entity: Entity, features: QueryFeatures): PostmanNode[] {
  const fields = entityQueryFields(entity);
  const entries: PostmanNode[] = [
    { key: 'page', value: '1' },
    { key: 'limit', value: '20' },
  ];
  if (features.search && fields.searchable.length > 0) {
    entries.push({ key: 'search', value: '', disabled: true });
  }
  if (features.sort && fields.sortable.length > 0) {
    entries.push({ key: 'sort', value: fields.sortable[0] ?? '', disabled: true });
  }
  if (features.include && fields.includable.length > 0) {
    entries.push({ key: 'include', value: fields.includable.join(','), disabled: true });
  }
  if (features.filter && fields.filterable.length > 0) {
    // One example filter rather than every field: the collection is a starting
    // point, and a request carrying a dozen disabled rows is harder to read.
    entries.push({ key: fields.filterable[0] ?? '', value: '', disabled: true });
  }
  return entries;
}

function urlWithQuery(pathSegments: string[], query: PostmanNode[]): PostmanNode {
  const enabled = query.filter((entry) => entry['disabled'] !== true);
  return {
    raw:
      `{{baseUrl}}/${pathSegments.join('/')}` +
      (enabled.length > 0
        ? `?${enabled.map((entry) => `${entry['key']}=${entry['value']}`).join('&')}`
        : ''),
    host: ['{{baseUrl}}'],
    path: pathSegments,
    query,
  };
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
  options: DocsOptions = {},
): Record<string, string> {
  const chosen = new Set(ips.generationConfig.methods);
  const methods = HTTP_METHODS.filter((m): m is HttpMethod => chosen.has(m));
  const features = queryFeatures(ips.generationConfig);

  // Resolved once, from the same helper the runtime and the OpenAPI generator
  // read — so the `Authorization` headers this emits and the endpoints that
  // actually demand one are the same set.
  const auth = projectAuth(ips);
  const authOn = authEnabled(auth);

  const folders: PostmanNode[] = [];
  for (const entity of ips.entities) {
    const entityPath = entitySlug(entity);
    const example = firstExample(examples, entity.name);
    const requests: PostmanNode[] = [];

    /*
     * §20: protected requests carry `Bearer {{accessToken}}`.
     *
     * Per request rather than as collection-level auth, because a COMBINATION
     * project has both kinds — collection-level auth would send a token to the
     * public entities too. Harmless at runtime, but it would misrepresent which
     * endpoints need credentials to anyone reading the collection to find out.
     */
    const authHeader =
      authOn && entityAuth(auth, entity) === 'PROTECTED' ? bearerHeader() : [];

    if (methods.includes('GET')) {
      requests.push({
        name: `List ${entity.name}`,
        request: {
          method: 'GET',
          header: [...authHeader],
          url: urlWithQuery([entityPath], listQuery(entity, features)),
        },
      });
      requests.push({
        name: `Get ${entity.name} by id`,
        request: { method: 'GET', header: [...authHeader], url: url([entityPath, ':recordId']) },
      });
    }
    if (methods.includes('POST')) {
      requests.push({
        name: `Create ${entity.name}`,
        request: {
          method: 'POST',
          header: [...JSON_HEADER, ...authHeader],
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
          header: [...JSON_HEADER, ...authHeader],
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
          header: [...JSON_HEADER, ...authHeader],
          body: jsonBody(example),
          url: url([entityPath, ':recordId']),
        },
      });
    }
    if (methods.includes('DELETE')) {
      requests.push({
        name: `Delete ${entity.name}`,
        request: { method: 'DELETE', header: [...authHeader], url: url([entityPath, ':recordId']) },
      });
    }

    folders.push({
      name: entity.name,
      ...(entity.description ? { description: entity.description } : {}),
      item: requests,
    });
  }

  const collection: PostmanNode = {
    info: {
      name: `InstantMockAPI — project ${ips.projectId} (v${ips.version})`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: serverUrl(ips, options) },
      { key: 'recordId', value: '' },
      // Every credential variable is empty (§20). This collection ships in the
      // export bundle and may be committed, so a captured token baked in would
      // be a leaked credential with a seven-day life.
      ...(authOn ? authVariables(auth) : []),
    ],
    // Authentication first: it is the folder a user has to run before anything
    // in a protected project works.
    item: authOn ? [authFolder(auth), ...folders] : folders,
  };

  return { 'postman_collection.json': JSON.stringify(collection, null, 2) };
}

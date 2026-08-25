/**
 * The Single API flow's model: endpoints rather than entities.
 *
 * An endpoint *is* an entity — the runtime routes every entity at its lowercased
 * name, so an endpoint called `current` is an entity `Current` served at
 * `/current`. This module owns that translation and the rules that make it safe,
 * so the wizard can talk about endpoints while the backend keeps receiving the
 * IPS it already understands.
 *
 * The design's "Base Path" is the project **slug**: a Single API advertises
 * `/p/{sng_id}/{basePath}/{endpoint}`, which is exactly the pretty URL shape from
 * Phase 3. No new addressing concept is involved.
 */

import { builderFieldToIPS, newField, nextId, type BuilderField } from './builder';

export interface SingleEndpoint {
  id: string;
  /** Author-facing name; becomes the entity name and the URL segment. */
  name: string;
  description: string;
  fields: BuilderField[];
}

export function newEndpoint(name = ''): SingleEndpoint {
  return { id: nextId(), name, description: '', fields: [newField('name')] };
}

/** URL segment for an endpoint — mirrors the hosting generator's entityPath. */
export function endpointPath(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Entity name for an endpoint.
 *
 * Capitalised because entity names are PascalCase by convention throughout the
 * IPS, and the generated TypeScript interface takes this name verbatim — a
 * lowercase `current` would produce `interface current`.
 */
export function entityNameFor(name: string): string {
  const trimmed = name.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export interface EndpointIssue {
  endpointId: string;
  field: 'name';
  message: string;
}

/**
 * Problems with the authored endpoints.
 *
 * The path-collision check is the one that matters: the runtime indexes entities
 * by path in a Map, so two endpoints differing only in case would silently
 * collapse to one served route and the other would 404 with nothing to explain
 * why.
 */
export function validateEndpoints(endpoints: SingleEndpoint[]): EndpointIssue[] {
  const issues: EndpointIssue[] = [];
  const pathCounts = new Map<string, number>();

  for (const endpoint of endpoints) {
    const name = endpoint.name.trim();
    if (!name) {
      issues.push({
        endpointId: endpoint.id,
        field: 'name',
        message: 'Give the endpoint a name — it becomes its URL segment.',
      });
      continue;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      issues.push({
        endpointId: endpoint.id,
        field: 'name',
        message: 'Use letters, digits and underscores, starting with a letter.',
      });
      continue;
    }
    const path = endpointPath(name);
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  }

  for (const endpoint of endpoints) {
    const path = endpointPath(endpoint.name);
    if (endpoint.name.trim() && (pathCounts.get(path) ?? 0) > 1) {
      issues.push({
        endpointId: endpoint.id,
        field: 'name',
        message: `Another endpoint also resolves to /${path} — names differing only in case collide.`,
      });
    }
  }

  return issues;
}

/**
 * Serialize endpoints into IPS entities.
 *
 * Unnamed endpoints and unnamed fields are dropped rather than sent: they cannot
 * be routed or generated, and the API would reject the whole payload for them.
 */
export function endpointsToEntities(endpoints: SingleEndpoint[]): Record<string, unknown>[] {
  return endpoints
    .filter((endpoint) => endpoint.name.trim())
    .map((endpoint) => ({
      name: entityNameFor(endpoint.name),
      ...(endpoint.description.trim() ? { description: endpoint.description.trim() } : {}),
      fields: endpoint.fields.filter((field) => field.name.trim()).map(builderFieldToIPS),
      relations: [],
    }));
}

/**
 * Turn an authored base path into a slug.
 *
 * Accepts what someone would type into a field labelled "Base Path" — a leading
 * slash, mixed case, spaces — and yields the kebab-case segment the API accepts.
 * Returns an empty string when nothing usable survives, which the caller reads as
 * "let the server derive one from the name".
 */
export function basePathToSlug(basePath: string): string {
  return (
    basePath
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '')
      // Nested paths are not addressable — the slug is a single segment — so any
      // separator collapses to a hyphen rather than being silently truncated.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '')
  );
}

/** Preview of the hosted path for one endpoint, for the authoring screen. */
export function previewPath(basePath: string, endpointName: string): string {
  const slug = basePathToSlug(basePath);
  const path = endpointPath(endpointName);
  return `/p/{publicId}/${slug || '{slug}'}/${path || '{endpoint}'}`;
}

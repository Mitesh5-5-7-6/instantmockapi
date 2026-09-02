/**
 * The dependency graph: what a hosted API is made of, and what reads what.
 *
 * The graph exists to answer one question precisely — *"which of my APIs does
 * this edit affect?"* — and to answer it without over-reporting. The naive
 * answer, "everything belonging to the entity you touched", is wrong in a way
 * users notice immediately: changing the type of `age` does not affect
 * `DELETE /user/{id}`, because DELETE reads a path parameter and nothing else.
 * A tool that claims otherwise trains people to ignore it.
 *
 * ## Shape
 *
 * ```
 * project
 *  ├── entity                     ent_…
 *  │    ├── field                 fld_…   (nested leaves too, dotted)
 *  │    └── relation              rel_…
 *  ├── endpoint                   GET /user/{id}
 *  └── generator                  openapi, zod, typescript, mock_data, hosted_api, …
 * ```
 *
 * The Method / Request / Response / Query facets of an endpoint are **not**
 * separate nodes. They are what an edge's `aspect` names, and `reason` points
 * inside — `aspect: 'write'` with `reason: 'request.body.email'` *is* the
 * Request facet of that endpoint. Modelling them as nodes would add four
 * identity-less children per endpoint and force every consumer to hop twice to
 * group results by API, which is the grouping every consumer actually wants.
 * `edgeFacet` maps an edge back to the facet name for a UI that renders the
 * sub-tree.
 *
 * ## Identity
 *
 * Nodes are keyed by the **stable schema id** (`field:fld_9a3c…`), not by the
 * readable path (`field:user.email`). The readable form lives in `label`. This
 * is the whole reason ids were pushed into the IPS: a graph keyed on names is a
 * pile of string comparisons that works beautifully until somebody renames a
 * field, at which point every edge silently points at nothing. Renaming
 * `email` to `emailAddress` must be one field changing, not one vanishing and
 * an unrelated one appearing — and only an id survives that.
 *
 * A field with no id (any schema written before Phase 1, until `ensureSchemaIds`
 * runs) still gets a node, keyed by its path so the graph renders completely.
 * Impact analysis cannot attribute changes to it, because `diffSchemas` cannot
 * pair it either. Backfill first; the fallback is for display, not for accuracy.
 *
 * ## Purity
 *
 * No I/O, no database, no version lookups. Given an IPS and a config it returns
 * the same graph every time, which is what makes the impact rules testable
 * exhaustively rather than by inspection.
 */

import type { ArtifactType, HttpMethod } from '@instantmockapi/shared';
import {
  entityEndpoints,
  entitySlug,
  projectEndpoints,
  type EndpointRow,
} from '@instantmockapi/shared';

import { entityQueryFields, resolveQueryFeatures } from './query.js';
import type { Entity, Field, GenerationConfig, InternalProjectSchema, Relation } from './types.js';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind = 'project' | 'entity' | 'field' | 'relation' | 'endpoint' | 'generator';

/**
 * How one node depends on another.
 *
 * - `contains` — structural only: project holds entity, entity holds field.
 *   Never traversed for impact. It exists so the graph can be *drawn* as the
 *   tree above without a second data structure.
 * - `read` — the target's response body is shaped by the source.
 * - `write` — the target's request body is shaped by the source.
 * - `query` — the source appears in the target's query string.
 * - `routing` — the target's URL, or its existence, depends on the source.
 */
export type EdgeAspect = 'contains' | 'read' | 'write' | 'query' | 'routing';

export interface GraphNode {
  /** `entity:ent_…`, `field:fld_…`, `endpoint:GET /user/{id}`, `generator:openapi`. */
  id: string;
  kind: NodeKind;
  /** Readable form: `User`, `User.email`, `GET /user/{id}`, `OpenAPI`. */
  label: string;
  /** Containing node, mirroring the `contains` edge. Absent on `project`. */
  parent?: string;
  /**
   * The `ent_`/`fld_`/`rel_` id this node came from.
   *
   * Absent on endpoint and generator nodes, which are derived rather than
   * stored, and absent on any schema element still awaiting backfill — which is
   * exactly the set impact analysis cannot attribute changes to.
   */
  schemaId?: string;
  /** Present on endpoint nodes: the derived row, verbatim. */
  endpoint?: EndpointRow;
  /** Present on generator nodes: the artifact registry key. */
  artifact?: ArtifactType;
}

export interface DependencyEdge {
  source: string;
  target: string;
  aspect: EdgeAspect;
  /**
   * Where in the target the dependency lands — `request.body.email`,
   * `response.User[].address.city`, `request.query.sort=age`, `path./user`.
   *
   * This is the string that answers "why is this API affected?" in the UI. It
   * is deliberately a precise pointer rather than a sentence, so a caller can
   * render it as a code fragment beside the change that produced it.
   */
  reason: string;
}

export interface DependencyGraph {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: readonly DependencyEdge[];
  /** Out-edges indexed by source id — the traversal impact analysis performs. */
  out: ReadonlyMap<string, readonly DependencyEdge[]>;
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

export const PROJECT_NODE = 'project';

export const entityNode = (id: string): string => `entity:${id}`;
export const fieldNode = (id: string): string => `field:${id}`;
export const relationNode = (id: string): string => `relation:${id}`;
export const generatorNode = (artifact: ArtifactType): string => `generator:${artifact}`;

/**
 * Endpoint node id.
 *
 * `(method, path)` rather than a stored id, because endpoints are still derived
 * on every read by `projectEndpoints`. The discovery document's empty path
 * normalises to `/` so the id is never `endpoint:GET ` with a trailing space.
 *
 * This is the one node id that moves when an entity is renamed — which is
 * correct, and is the point of the `ROUTING` risk level: the endpoint really did
 * move. Phase 2's endpoint registry gives these stable ids; until then, a rename
 * is legitimately a different URL.
 */
export const endpointNode = (method: HttpMethod, path: string): string =>
  `endpoint:${method} ${path === '' ? '/' : path}`;

const endpointNodeOf = (row: EndpointRow): string => endpointNode(row.method, row.path);

/** The facet of an endpoint an edge points at, in the vocabulary of the tree above. */
export function edgeFacet(edge: DependencyEdge): 'request' | 'response' | 'query' | 'path' | null {
  switch (edge.aspect) {
    case 'read':
      return 'response';
    case 'write':
      return 'request';
    case 'query':
      return 'query';
    case 'routing':
      return 'path';
    case 'contains':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * What each generator reads.
 *
 * `schema` generators consume entity shapes; `surface` generators consume the
 * endpoint list as well. Nothing here is derived from the generator sources — it
 * is a **deliberately conservative superset**, declared once so it can be
 * corrected in one place when Phase 2 wires selective regeneration to it.
 *
 * Erring wide is the safe direction: regenerating an artifact that did not need
 * it costs seconds, while skipping one that did leaves a published API
 * disagreeing with its own documentation. Phase 1's affected-API answer does not
 * consult this map at all.
 */
const GENERATOR_INPUTS: Record<ArtifactType, 'schema' | 'surface'> = {
  ips: 'schema',
  json_schema: 'schema',
  zod: 'schema',
  yup: 'schema',
  typescript: 'schema',
  mock_data: 'schema',
  openapi: 'surface',
  postman: 'surface',
  hosted_api: 'surface',
  export_zip: 'surface',
};

const GENERATOR_LABELS: Record<ArtifactType, string> = {
  ips: 'IPS',
  json_schema: 'JSON Schema',
  zod: 'Zod',
  yup: 'Yup',
  typescript: 'TypeScript',
  mock_data: 'Mock Data',
  openapi: 'OpenAPI',
  postman: 'Postman',
  hosted_api: 'Hosted API',
  export_zip: 'Export ZIP',
};

const GENERATOR_ENTRIES = Object.entries(GENERATOR_INPUTS) as [
  ArtifactType,
  'schema' | 'surface',
][];

// ---------------------------------------------------------------------------
// Field flattening
// ---------------------------------------------------------------------------

interface FlatField {
  field: Field;
  /** Dotted path from the entity root: `address.city`. */
  path: string;
}

/**
 * Every leaf and branch of an entity's fields, with dotted paths.
 *
 * Branches are included, not only leaves: changing an object field's type from
 * `object` to `string` is a change to `address` itself, and there must be a node
 * for `diffSchemas` to point at.
 */
function flattenFields(fields: readonly Field[] | undefined, prefix = ''): FlatField[] {
  if (!Array.isArray(fields)) {
    return [];
  }
  const flat: FlatField[] = [];
  for (const field of fields) {
    if (field === null || typeof field !== 'object' || typeof field.name !== 'string') {
      continue;
    }
    const path = prefix === '' ? field.name : `${prefix}.${field.name}`;
    flat.push({ field, path });
    flat.push(...flattenFields(field.children, path));
  }
  return flat;
}

function entityList(ips: InternalProjectSchema): Entity[] {
  return Array.isArray(ips.entities) ? ips.entities : [];
}

function relationList(entity: Entity): Relation[] {
  return Array.isArray(entity.relations) ? entity.relations : [];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: DependencyEdge[] = [];

  node(node: GraphNode): string {
    // First writer wins. Two entities can only derive the same endpoint id if
    // they share a name, which `validateIPS` rejects — but the graph must not
    // corrupt itself if it is ever handed one that slipped through, so the
    // collision is absorbed rather than duplicated.
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
    return node.id;
  }

  edge(source: string, target: string, aspect: EdgeAspect, reason: string): void {
    this.edges.push({ source, target, aspect, reason });
  }

  finish(): DependencyGraph {
    const out = new Map<string, DependencyEdge[]>();
    for (const edge of this.edges) {
      const bucket = out.get(edge.source);
      if (bucket === undefined) {
        out.set(edge.source, [edge]);
      } else {
        bucket.push(edge);
      }
    }
    return { nodes: this.nodes, edges: this.edges, out };
  }
}

/**
 * Build the dependency graph for one project definition.
 *
 * `config.methods` and `config.features` decide which endpoints exist and which
 * query parameters they accept, so the same entities under different configs
 * produce genuinely different graphs. It defaults to the IPS own
 * `generationConfig`; pass it explicitly only when a draft is editing the config
 * separately from the schema, and then pass the config that will be *published*,
 * never the one currently live.
 */
export function buildDependencyGraph(
  ips: InternalProjectSchema,
  config: GenerationConfig | undefined = ips.generationConfig,
): DependencyGraph {
  const builder = new GraphBuilder();
  const methods: readonly string[] = Array.isArray(config?.methods) ? config.methods : [];
  const features = resolveQueryFeatures(config?.features);

  builder.node({ id: PROJECT_NODE, kind: 'project', label: ips.projectId ?? 'Project' });

  for (const [artifact] of GENERATOR_ENTRIES) {
    builder.node({
      id: generatorNode(artifact),
      kind: 'generator',
      label: GENERATOR_LABELS[artifact],
      parent: PROJECT_NODE,
      artifact,
    });
  }

  // The discovery document. Always present, whatever methods were selected — the
  // base URL answers with the entity catalogue regardless. Taken from
  // `projectEndpoints` with no entities so its shape stays defined in one place.
  const index = projectEndpoints([], methods)[0];
  const indexId =
    index === undefined
      ? undefined
      : builder.node({
          id: endpointNodeOf(index),
          kind: 'endpoint',
          label: `${index.method} /`,
          parent: PROJECT_NODE,
          endpoint: index,
        });

  if (indexId !== undefined) {
    for (const [artifact, inputs] of GENERATOR_ENTRIES) {
      if (inputs === 'surface') {
        builder.edge(indexId, generatorNode(artifact), 'read', 'paths.GET /');
      }
    }
  }

  for (const entity of entityList(ips)) {
    if (entity === null || typeof entity !== 'object' || typeof entity.name !== 'string') {
      continue;
    }
    buildEntity(builder, entity, methods, features, indexId);
  }

  return builder.finish();
}

type Features = ReturnType<typeof resolveQueryFeatures>;
type QueryFieldLists = ReturnType<typeof entityQueryFields>;

function buildEntity(
  builder: GraphBuilder,
  entity: Entity,
  methods: readonly string[],
  features: Features,
  indexId: string | undefined,
): void {
  const entityId = builder.node({
    id: entityNode(entity.id ?? `name:${entity.name}`),
    kind: 'entity',
    label: entity.name,
    parent: PROJECT_NODE,
    ...(entity.id !== undefined ? { schemaId: entity.id } : {}),
  });
  builder.edge(PROJECT_NODE, entityId, 'contains', `entities.${entity.name}`);

  const rows = entityEndpoints(entity, methods);
  const endpointIds = new Map<EndpointRow, string>();
  for (const row of rows) {
    const id = builder.node({
      id: endpointNodeOf(row),
      kind: 'endpoint',
      label: `${row.method} ${row.path}`,
      parent: entityId,
      endpoint: row,
    });
    endpointIds.set(row, id);

    // The entity name IS the path segment (`entitySlug` in `shared/routing.ts`),
    // so renaming the entity moves every one of its endpoints. That is this
    // edge, and it is why `ENTITY_RENAMED` is ROUTING rather than BREAKING: the
    // endpoint still works, at a different URL.
    builder.edge(entityId, id, 'routing', `path./${entitySlug(entity)}`);

    // Whole-shape edges, at entity granularity.
    //
    // These are what a change that can only be attributed to the entity travels
    // along — a *removed* field, most importantly, which has no node of its own
    // in the draft graph because the draft is the definition it was removed from.
    // Without them a deletion would report as affecting nothing.
    //
    // DELETE is deliberately excluded, exactly as it is for fields: its contract
    // is a path parameter and an empty body, and removing an unrelated field does
    // not change either. The entity-level fallback is wider than a field-level
    // change, but it is not "everything under this entity".
    if (row.method !== 'DELETE') {
      const shape = row.target === 'collection' && row.method === 'GET' ? '[]' : '';
      builder.edge(entityId, id, 'read', `response.${entity.name}${shape}`);
      if (row.method !== 'GET') {
        builder.edge(entityId, id, 'write', `request.body.${entity.name}`);
      }
    }

    for (const [artifact, inputs] of GENERATOR_ENTRIES) {
      if (inputs === 'surface') {
        builder.edge(id, generatorNode(artifact), 'read', `paths.${row.method} ${row.path}`);
      }
    }
  }

  // An entity appearing, disappearing or being renamed rewrites the catalogue
  // the base URL serves. A field change does not — which is why this edge hangs
  // off the entity and not off its fields.
  //
  // Two aspects, deliberately. The catalogue is a response body, so a read edge
  // is obvious. It is also the document a client reads to *find* the routes, and
  // each row carries an entity name and its path — so renaming an entity changes
  // what the base URL serves just as surely as it moves the entity's own URLs.
  // Without the routing edge, `ENTITY_RENAMED` (aspect `routing`) would report
  // every moved endpoint and quietly miss the document that advertises them.
  if (indexId !== undefined) {
    builder.edge(entityId, indexId, 'read', 'response.entities[]');
    builder.edge(entityId, indexId, 'routing', 'response.entities[].path');
  }

  for (const [artifact, inputs] of GENERATOR_ENTRIES) {
    if (inputs === 'schema') {
      builder.edge(entityId, generatorNode(artifact), 'read', `types.${entity.name}`);
    }
  }

  // One pass, shared by the query layer and the field walk, so the two cannot
  // disagree about which fields exist.
  const ownFields = (Array.isArray(entity.fields) ? entity.fields : []).filter(
    (field): field is Field =>
      field !== null && typeof field === 'object' && typeof field.name === 'string',
  );

  const ctx: EntityContext = {
    entity,
    entityId,
    identityName: entity.identity?.field ?? 'id',
    rows,
    endpointIds,
    // Cleaned, not raw: `entityQueryFields` dereferences `field.type` on every
    // entry, so one null in a ragged legacy document would throw. The graph is
    // the last place that should refuse to render a schema it was handed.
    query: entityQueryFields({ fields: ownFields, relations: entity.relations }),
    features,
  };

  for (const { field, path } of flattenFields(ownFields)) {
    buildField(builder, ctx, field, path);
  }
  for (const relation of relationList(entity)) {
    buildRelation(builder, ctx, relation);
  }
}

interface EntityContext {
  entity: Entity;
  entityId: string;
  identityName: string;
  rows: readonly EndpointRow[];
  endpointIds: Map<EndpointRow, string>;
  query: QueryFieldLists;
  features: Features;
}

/**
 * Wire one field to the endpoints that actually touch it.
 *
 * The precision this function exists for, stated as a rule: **an endpoint
 * depends on a field only if the field crosses its wire.** A collection GET
 * returns every field, so every field is a `read` dependency of it. A DELETE
 * sends an identifier in the path and returns no body, so it depends on the
 * identity field and on nothing else — `DELETE /user/{id}` is unaffected by a
 * change to `age`, and reporting otherwise is the exact over-approximation that
 * makes an impact report useless.
 */
function buildField(builder: GraphBuilder, ctx: EntityContext, field: Field, path: string): void {
  const { entity, entityId, identityName, rows, endpointIds, query, features } = ctx;

  const fieldId = builder.node({
    id: fieldNode(field.id ?? `name:${entity.name}.${path}`),
    kind: 'field',
    label: `${entity.name}.${path}`,
    parent: entityId,
    ...(field.id !== undefined ? { schemaId: field.id } : {}),
  });
  builder.edge(entityId, fieldId, 'contains', `fields.${path}`);

  // Only the entity's own identity field addresses a record. A nested field
  // named `id` inside `address` is not an identifier, hence comparing the whole
  // dotted path rather than the field name.
  const isIdentity = path === identityName || field.meta?.identity === true;
  // Server-assigned fields are stripped from request bodies by `exampleBody` and
  // overwritten by the runtime, so they shape responses but never requests.
  const isServerAssigned = isIdentity || field.meta?.readOnly === true;
  const isTopLevel = !path.includes('.');

  for (const row of rows) {
    const endpointId = endpointIds.get(row);
    if (endpointId === undefined) {
      continue;
    }

    if (row.method === 'DELETE') {
      // The one endpoint that reads a single field and returns no body.
      if (isIdentity) {
        builder.edge(fieldId, endpointId, 'routing', `request.path.${identityName}`);
      }
      continue;
    }

    // Only a collection GET answers with an array. POST is collection-targeted
    // too but returns the single record it created, so the array marker would
    // point a user at a response shape that does not exist.
    const suffix = row.target === 'collection' && row.method === 'GET' ? '[]' : '';
    const responseReason = `response.${entity.name}${suffix}.${path}`;

    if (row.method === 'GET') {
      builder.edge(fieldId, endpointId, 'read', responseReason);
      if (row.target === 'collection' && isTopLevel) {
        addQueryEdges(builder, fieldId, endpointId, path, query, features);
      }
      continue;
    }

    // POST, PUT and PATCH all accept a body and echo the stored record back, so
    // a field change moves in both directions on them.
    if (!isServerAssigned) {
      builder.edge(fieldId, endpointId, 'write', `request.body.${path}`);
    }
    builder.edge(fieldId, endpointId, 'read', responseReason);

    // Item writes address the record by its identity, exactly as DELETE does.
    if (row.target === 'item' && isIdentity) {
      builder.edge(fieldId, endpointId, 'routing', `request.path.${identityName}`);
    }
  }
}

/**
 * Query-string edges for a top-level scalar on a collection GET.
 *
 * Nested leaves are excluded because the query layer excludes them —
 * `queryableFields` returns top-level scalars only, and `?author.name=` is not a
 * supported parameter. Claiming an edge the runtime would answer 400 on would be
 * a fiction the report then reasons from.
 */
function addQueryEdges(
  builder: GraphBuilder,
  fieldId: string,
  endpointId: string,
  path: string,
  query: QueryFieldLists,
  features: Features,
): void {
  if (features.search && query.searchable.includes(path)) {
    builder.edge(fieldId, endpointId, 'query', 'request.query.search');
  }
  if (features.filter && query.filterable.includes(path)) {
    builder.edge(fieldId, endpointId, 'query', `request.query.${path}`);
  }
  if (features.sort && query.sortable.includes(path)) {
    builder.edge(fieldId, endpointId, 'query', `request.query.sort=${path}`);
  }
}

/**
 * Wire one relation to the endpoints that expose it.
 *
 * A relation reaches the wire twice: as `?include=<name>`, and as the embedded
 * object that include produces. Its **foreign key does not appear here** —
 * `materializeRelations` turns it into a real field named `relation.localField`,
 * which therefore already has its own node and its own precise `request.body.…`
 * edge. Emitting a second write edge from the relation would double-count every
 * foreign-key change in the affected-API list.
 */
function buildRelation(builder: GraphBuilder, ctx: EntityContext, relation: Relation): void {
  const { entity, entityId, rows, endpointIds, features } = ctx;
  if (relation === null || typeof relation !== 'object' || typeof relation.name !== 'string') {
    return;
  }

  const relationId = builder.node({
    id: relationNode(relation.id ?? `name:${entity.name}.${relation.name}`),
    kind: 'relation',
    label: `${entity.name}.${relation.name}`,
    parent: entityId,
    ...(relation.id !== undefined ? { schemaId: relation.id } : {}),
  });
  builder.edge(entityId, relationId, 'contains', `relations.${relation.name}`);

  for (const row of rows) {
    const endpointId = endpointIds.get(row);
    if (endpointId === undefined || row.method !== 'GET') {
      continue;
    }
    const suffix = row.target === 'collection' ? '[]' : '';
    builder.edge(
      relationId,
      endpointId,
      'read',
      `response.${entity.name}${suffix}.${relation.name}`,
    );
    if (features.include) {
      builder.edge(relationId, endpointId, 'query', `request.query.include=${relation.name}`);
    }
  }
}

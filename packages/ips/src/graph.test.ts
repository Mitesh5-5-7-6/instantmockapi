import { describe, it, expect } from 'vitest';

import {
  buildDependencyGraph,
  edgeFacet,
  endpointNode,
  fieldNode,
  generatorNode,
  PROJECT_NODE,
  type DependencyEdge,
  type DependencyGraph,
} from './graph.js';
import { ensureSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
import type { Entity, Field, InternalProjectSchema, Relation } from './types.js';

function field(name: string, over: Partial<Field> = {}): Field {
  return {
    name,
    type: 'string',
    required: false,
    default: null,
    children: [],
    validation: {},
    meta: {},
    ...over,
  };
}

function entity(name: string, fields: Field[], over: Partial<Entity> = {}): Entity {
  return { name, fields, identity: { field: 'id', style: 'int' }, ...over };
}

function ips(
  entities: Entity[],
  config: Partial<InternalProjectSchema['generationConfig']> = {},
): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities,
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 10,
      ...config,
    },
  } as InternalProjectSchema;
}

/**
 * Materialize, backfill ids, then build — the order every real caller uses.
 *
 * `materializeRelations` is what turns `identity: { field: "id" }` into an
 * actual `id` field and a relation into an actual foreign-key field. Every
 * stored IPS has been through it, so a fixture that skips it would test a
 * document shape that never reaches the graph in production — and would hide
 * the identity-field routing rules entirely.
 */
function graphOf(schema: InternalProjectSchema): DependencyGraph {
  const materialized = materializeRelations(schema);
  ensureSchemaIds(materialized);
  return buildDependencyGraph(materialized);
}

/** Edges from a field, by the field's readable label. */
function edgesFromField(graph: DependencyGraph, label: string): DependencyEdge[] {
  for (const node of graph.nodes.values()) {
    if (node.kind === 'field' && node.label === label) {
      return [...(graph.out.get(node.id) ?? [])];
    }
  }
  throw new Error(`no field node labelled ${label}`);
}

/** Edges from a field into one endpoint. */
function edgesInto(graph: DependencyGraph, label: string, endpoint: string): DependencyEdge[] {
  return edgesFromField(graph, label).filter((edge) => edge.target === endpoint);
}

const USERS = 'endpoint:GET /user';
const USER_ITEM = 'endpoint:GET /user/{id}';
const CREATE = 'endpoint:POST /user';
const PATCH = 'endpoint:PATCH /user/{id}';
const PUT = 'endpoint:PUT /user/{id}';
const REMOVE = 'endpoint:DELETE /user/{id}';

describe('node construction', () => {
  it('builds the project, entity, field, endpoint and generator tiers', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const kinds = new Set([...graph.nodes.values()].map((node) => node.kind));
    expect([...kinds].sort()).toEqual(['endpoint', 'entity', 'field', 'generator', 'project']);
  });

  it('keys nodes by stable id and labels them readably', () => {
    const schema = ips([entity('User', [field('email')])]);
    ensureSchemaIds(schema);
    const fieldId = schema.entities[0]!.fields[0]!.id!;

    const graph = buildDependencyGraph(schema);
    const node = graph.nodes.get(fieldNode(fieldId));
    expect(node).toMatchObject({ kind: 'field', label: 'User.email', schemaId: fieldId });
  });

  /**
   * The reason ids were pushed into the IPS at all. If nodes were keyed on the
   * readable path, this id would change with the rename and every edge pointing
   * at it would silently dangle.
   */
  it('keeps a field node id stable across a rename', () => {
    const schema = ips([entity('User', [field('email')])]);
    ensureSchemaIds(schema);
    const before = buildDependencyGraph(schema);

    schema.entities[0]!.fields[0]!.name = 'emailAddress';
    const after = buildDependencyGraph(schema);

    const beforeIds = [...before.nodes.values()].filter((n) => n.kind === 'field').map((n) => n.id);
    const afterIds = [...after.nodes.values()].filter((n) => n.kind === 'field').map((n) => n.id);
    expect(afterIds).toEqual(beforeIds);
  });

  it('falls back to a path-keyed node for a field with no id', () => {
    // No `ensureSchemaIds` call. The graph must still render completely.
    const graph = buildDependencyGraph(ips([entity('User', [field('email')])]));
    const node = graph.nodes.get(fieldNode('name:User.email'));
    expect(node).toMatchObject({ kind: 'field', label: 'User.email' });
    expect(node?.schemaId).toBeUndefined();
  });

  it('gives nested leaves dotted labels and their own nodes', () => {
    const graph = graphOf(
      ips([
        entity('User', [
          field('address', { type: 'object', children: [field('city'), field('zip')] }),
        ]),
      ]),
    );
    const labels = [...graph.nodes.values()]
      .filter((node) => node.kind === 'field')
      .map((node) => node.label)
      .sort();
    // The branch itself is a node too: changing `address` from object to string
    // is a change to `address`, and the diff needs somewhere to point.
    expect(labels).toEqual(['User.address', 'User.address.city', 'User.address.zip', 'User.id']);
  });

  it('includes the discovery document whatever methods were selected', () => {
    const graph = graphOf(ips([entity('User', [field('email')])], { methods: [] }));
    expect(graph.nodes.has(endpointNode('GET', ''))).toBe(true);
    expect(graph.nodes.get('endpoint:GET /')?.label).toBe('GET /');
  });

  it('derives only the endpoints the selected methods produce', () => {
    const graph = graphOf(ips([entity('User', [field('email')])], { methods: ['GET'] }));
    const endpoints = [...graph.nodes.values()]
      .filter((node) => node.kind === 'endpoint')
      .map((node) => node.id)
      .sort();
    expect(endpoints).toEqual(['endpoint:GET /', USERS, USER_ITEM]);
  });
});

describe('field to endpoint edges', () => {
  /**
   * The requirement this whole module exists for. `age` never crosses DELETE's
   * wire: DELETE sends an identifier in the path and returns no body. An impact
   * report that flags it trains users to ignore the report.
   */
  it('gives an ordinary field NO edge to DELETE', () => {
    const graph = graphOf(
      ips([entity('User', [field('email'), field('age', { type: 'integer' })])]),
    );
    expect(edgesInto(graph, 'User.age', REMOVE)).toEqual([]);
    expect(edgesInto(graph, 'User.email', REMOVE)).toEqual([]);
  });

  it('gives the identity field a routing edge to DELETE, and only that', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(edgesInto(graph, 'User.id', REMOVE)).toEqual([
      { source: expect.any(String), target: REMOVE, aspect: 'routing', reason: 'request.path.id' },
    ]);
  });

  it('reads on a collection GET, with the array marker in the reason', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const edges = edgesInto(graph, 'User.email', USERS);
    expect(edges).toContainEqual(
      expect.objectContaining({ aspect: 'read', reason: 'response.User[].email' }),
    );
  });

  it('reads on an item GET without the array marker', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(edgesInto(graph, 'User.email', USER_ITEM)).toContainEqual(
      expect.objectContaining({ aspect: 'read', reason: 'response.User.email' }),
    );
  });

  /** The user's worked example, verbatim. */
  it('carries request.body.email as the write reason on POST and PATCH', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    for (const endpoint of [CREATE, PATCH, PUT]) {
      expect(edgesInto(graph, 'User.email', endpoint)).toContainEqual(
        expect.objectContaining({ aspect: 'write', reason: 'request.body.email' }),
      );
    }
  });

  it('moves in both directions on a write, because the record is echoed back', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const aspects = edgesInto(graph, 'User.email', PATCH).map((edge) => edge.aspect);
    expect(aspects.sort()).toEqual(['read', 'write']);
  });

  /**
   * Identity and read-only fields are stripped from request bodies by
   * `exampleBody` and overwritten by the runtime, so they shape responses but
   * never requests. A write edge here would tell a user to update a client that
   * was never sending the field.
   */
  it('gives a server-assigned field no write edge', () => {
    const graph = graphOf(
      ips([entity('User', [field('email'), field('createdAt', { meta: { readOnly: true } })])]),
    );
    const written = edgesFromField(graph, 'User.createdAt').filter((e) => e.aspect === 'write');
    expect(written).toEqual([]);
    expect(edgesFromField(graph, 'User.id').filter((e) => e.aspect === 'write')).toEqual([]);
  });

  it('does not treat a nested field named id as an identifier', () => {
    const graph = graphOf(
      ips([entity('User', [field('address', { type: 'object', children: [field('id')] })])]),
    );
    // `address.id` is not the record identifier, so DELETE does not read it.
    expect(edgesInto(graph, 'User.address.id', REMOVE)).toEqual([]);
    expect(edgesInto(graph, 'User.id', REMOVE)).toHaveLength(1);
  });

  it('routes item writes by the identity field too', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(edgesInto(graph, 'User.id', PATCH)).toContainEqual(
      expect.objectContaining({ aspect: 'routing', reason: 'request.path.id' }),
    );
  });

  it('names the configured identity field in the routing reason', () => {
    const graph = graphOf(
      ips([entity('Product', [field('sku')], { identity: { field: 'sku', style: 'uuid' } })]),
    );
    expect(edgesFromField(graph, 'Product.sku')).toContainEqual(
      expect.objectContaining({
        target: 'endpoint:DELETE /product/{sku}',
        aspect: 'routing',
        reason: 'request.path.sku',
      }),
    );
  });
});

describe('query edges', () => {
  it('attaches search, filter and sort to the collection GET only', () => {
    const graph = graphOf(
      ips([entity('User', [field('email')])], {
        features: { search: true, filter: true, sort: true, include: false },
      }),
    );
    const reasons = edgesInto(graph, 'User.email', USERS)
      .filter((edge) => edge.aspect === 'query')
      .map((edge) => edge.reason)
      .sort();
    expect(reasons).toEqual([
      'request.query.email',
      'request.query.search',
      'request.query.sort=email',
    ]);
    // An item GET takes no query parameters.
    expect(edgesInto(graph, 'User.email', USER_ITEM).filter((e) => e.aspect === 'query')).toEqual(
      [],
    );
  });

  it('emits no query edges when the features are off', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(edgesFromField(graph, 'User.email').filter((e) => e.aspect === 'query')).toEqual([]);
  });

  /**
   * `searchableFields` treats any explicit `meta.searchable` as the whitelist.
   * The graph must honour that, or it would claim `?search=` reaches a field the
   * runtime never scans.
   */
  it('honours the searchable whitelist', () => {
    const graph = graphOf(
      ips([entity('User', [field('email', { meta: { searchable: true } }), field('nickname')])], {
        features: { search: true, filter: false, sort: false, include: false },
      }),
    );
    expect(
      edgesInto(graph, 'User.email', USERS).some((e) => e.reason === 'request.query.search'),
    ).toBe(true);
    expect(
      edgesInto(graph, 'User.nickname', USERS).some((e) => e.reason === 'request.query.search'),
    ).toBe(false);
  });

  /**
   * `queryableFields` returns top-level scalars only — `?address.city=` is not a
   * supported parameter, and claiming the edge would be a fiction the impact
   * report then reasons from.
   */
  it('leaves nested leaves out of the query layer', () => {
    const graph = graphOf(
      ips([entity('User', [field('address', { type: 'object', children: [field('city')] })])], {
        features: { search: true, filter: true, sort: true, include: false },
      }),
    );
    expect(edgesFromField(graph, 'User.address.city').filter((e) => e.aspect === 'query')).toEqual(
      [],
    );
  });
});

describe('entity edges', () => {
  it('routes every one of its endpoints, because the name is the path', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const entityId = [...graph.nodes.values()].find((n) => n.kind === 'entity')!.id;
    const routing = (graph.out.get(entityId) ?? []).filter((e) => e.aspect === 'routing');

    expect(routing.map((e) => e.target).sort()).toEqual(
      // Plus the discovery document, whose rows carry each entity's name and path.
      [USERS, CREATE, USER_ITEM, PUT, PATCH, REMOVE, 'endpoint:GET /'].sort(),
    );
    expect(new Set(routing.map((e) => e.reason))).toEqual(
      new Set(['path./user', 'response.entities[].path']),
    );
  });

  it('reads the discovery document, so the catalogue tracks entity changes', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const entityId = [...graph.nodes.values()].find((n) => n.kind === 'entity')!.id;
    expect(graph.out.get(entityId)).toContainEqual(
      expect.objectContaining({ target: 'endpoint:GET /', reason: 'response.entities[]' }),
    );
  });

  /** A field change must not reach the catalogue — it lists entities, not fields. */
  it('does not let a field reach the discovery document', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(edgesInto(graph, 'User.email', 'endpoint:GET /')).toEqual([]);
  });
});

describe('relation edges', () => {
  const relation = (over: Partial<Relation> = {}): Relation =>
    ({
      name: 'author',
      kind: 'belongsTo',
      target: 'Author',
      localField: 'authorId',
      ...over,
    }) as Relation;

  it('exposes a relation as an include parameter and an embedded object', () => {
    const graph = graphOf(
      ips(
        [
          entity('Post', [field('title')], { relations: [relation()] }),
          entity('Author', [field('name')]),
        ],
        { features: { search: false, filter: false, sort: false, include: true } },
      ),
    );
    const node = [...graph.nodes.values()].find(
      (n) => n.kind === 'relation' && n.label === 'Post.author',
    )!;
    const edges = [...(graph.out.get(node.id) ?? [])];

    expect(edges).toContainEqual(
      expect.objectContaining({
        target: 'endpoint:GET /post',
        aspect: 'query',
        reason: 'request.query.include=author',
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        target: 'endpoint:GET /post',
        aspect: 'read',
        reason: 'response.Post[].author',
      }),
    );
  });

  /**
   * The foreign key is a real materialized field with its own node and its own
   * `request.body.authorId` edge. A second write edge from the relation would
   * double-count every foreign-key change in the affected-API list.
   */
  it('leaves the write path to the materialized foreign key', () => {
    const graph = graphOf(
      ips([
        entity('Post', [field('title')], { relations: [relation()] }),
        entity('Author', [field('name')]),
      ]),
    );
    const node = [...graph.nodes.values()].find((n) => n.kind === 'relation')!;

    expect([...(graph.out.get(node.id) ?? [])].filter((e) => e.aspect === 'write')).toEqual([]);
    expect(edgesFromField(graph, 'Post.authorId')).toContainEqual(
      expect.objectContaining({ aspect: 'write', reason: 'request.body.authorId' }),
    );
  });

  it('emits no include edge when the feature is off', () => {
    const graph = graphOf(
      ips([
        entity('Post', [field('title')], { relations: [relation()] }),
        entity('Author', [field('name')]),
      ]),
    );
    const node = [...graph.nodes.values()].find((n) => n.kind === 'relation')!;
    expect([...(graph.out.get(node.id) ?? [])].filter((e) => e.aspect === 'query')).toEqual([]);
  });
});

describe('generator edges', () => {
  it('points entities at the schema generators', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const entityId = [...graph.nodes.values()].find((n) => n.kind === 'entity')!.id;
    const targets = (graph.out.get(entityId) ?? [])
      .filter((e) => e.target.startsWith('generator:'))
      .map((e) => e.target)
      .sort();

    expect(targets).toEqual(
      [
        generatorNode('json_schema'),
        generatorNode('mock_data'),
        generatorNode('typescript'),
        generatorNode('yup'),
        generatorNode('zod'),
      ].sort(),
    );
  });

  it('points endpoints at the surface generators, naming the path', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const edges = (graph.out.get(REMOVE) ?? []).filter((e) => e.target.startsWith('generator:'));

    expect(edges.map((e) => e.target).sort()).toEqual(
      [
        generatorNode('export_zip'),
        generatorNode('hosted_api'),
        generatorNode('openapi'),
        generatorNode('postman'),
      ].sort(),
    );
    expect(new Set(edges.map((e) => e.reason))).toEqual(new Set(['paths.DELETE /user/{id}']));
  });

  it('wires the discovery document to the surface generators too', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    expect(graph.out.get('endpoint:GET /')).toContainEqual(
      expect.objectContaining({ target: generatorNode('hosted_api'), reason: 'paths.GET /' }),
    );
  });
});

describe('structure', () => {
  it('mirrors every contains edge in the parent field', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    for (const edge of graph.edges) {
      if (edge.aspect === 'contains') {
        expect(graph.nodes.get(edge.target)?.parent).toBe(edge.source);
      }
    }
  });

  it('never emits an edge to a node that does not exist', () => {
    const graph = graphOf(
      ips([
        entity('User', [
          field('email'),
          field('address', { type: 'object', children: [field('city')] }),
        ]),
      ]),
    );
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.source), `missing source ${edge.source}`).toBe(true);
      expect(graph.nodes.has(edge.target), `missing target ${edge.target}`).toBe(true);
    }
  });

  it('indexes out-edges consistently with the flat list', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    const counted = [...graph.out.values()].reduce((sum, bucket) => sum + bucket.length, 0);
    expect(counted).toBe(graph.edges.length);
  });

  it('parents everything except the project', () => {
    const graph = graphOf(ips([entity('User', [field('email')])]));
    for (const node of graph.nodes.values()) {
      if (node.id === PROJECT_NODE) {
        expect(node.parent).toBeUndefined();
      } else {
        expect(node.parent, `${node.id} has no parent`).toBeDefined();
      }
    }
  });

  it('maps edge aspects onto the endpoint facet names', () => {
    const facet = (aspect: DependencyEdge['aspect']) =>
      edgeFacet({ source: 'a', target: 'b', aspect, reason: 'r' });
    expect(facet('read')).toBe('response');
    expect(facet('write')).toBe('request');
    expect(facet('query')).toBe('query');
    expect(facet('routing')).toBe('path');
    expect(facet('contains')).toBeNull();
  });
});

describe('ragged input', () => {
  it('survives an entity with no fields array', () => {
    const graph = buildDependencyGraph(ips([{ name: 'User' } as unknown as Entity]));
    expect(graph.nodes.has('entity:name:User')).toBe(true);
  });

  it('skips entities and fields that are not objects', () => {
    const graph = buildDependencyGraph(
      ips([null as unknown as Entity, entity('User', [null as unknown as Field, field('email')])]),
    );
    const labels = [...graph.nodes.values()]
      .filter((n) => n.kind === 'field')
      .map((n) => n.label)
      .sort();
    // No `materializeRelations` here, so no synthesised `id` field — the point
    // is only that the two ragged entries were skipped rather than thrown on.
    expect(labels).toEqual(['User.email']);
  });

  it('handles a project with no entities', () => {
    const graph = graphOf(ips([]));
    const endpoints = [...graph.nodes.values()].filter((n) => n.kind === 'endpoint');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.id).toBe('endpoint:GET /');
  });
});

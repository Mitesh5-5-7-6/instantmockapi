/**
 * Impact analysis: which APIs does this edit affect, and why?
 *
 * `diffSchemas` says *what* changed. `buildDependencyGraph` says what reads
 * what. This module joins them and produces the answer a user is actually
 * asking for when they press Save:
 *
 * ```
 * PATCH /user/{id}
 *   └─ User.email
 *      └─ Type changed: string → integer
 *      └─ request.body.email
 *
 * DELETE /user/{id}
 *   └─ No impact
 * ```
 *
 * ## Why the unaffected list is a first-class output
 *
 * Listing what *is* affected is easy and unconvincing on its own — a user has
 * no way to tell a precise report from a lazy one that flagged everything. The
 * unaffected list is the claim being made: *these APIs keep working, and we are
 * saying so explicitly.* It is also the honest place to admit uncertainty,
 * which `unattributed` below does.
 *
 * ## The traversal
 *
 * Each change carries an `aspect` naming the direction it moves in. That aspect
 * selects which edge kinds may be followed out of the changed node:
 *
 * | change aspect | follows edges          | rationale                                    |
 * |---------------|------------------------|----------------------------------------------|
 * | `read`        | `read`, `query`        | a query parameter is how a read is shaped     |
 * | `write`       | `write`                | request bodies are not query-shaped           |
 * | `both`        | `read`, `write`, `query` | the union                                   |
 * | `routing`     | `routing`              | the URL moved, the payload did not            |
 * | `none`        | nothing                | a description change reaches no wire          |
 *
 * `contains` edges are never followed. Traversing them would put every endpoint
 * of an entity into the affected list the moment any one field changed, which
 * is precisely the over-approximation the graph was built to avoid — and would
 * make `DELETE /user/{id}` appear affected by a change to `age`.
 *
 * The traversal is one hop, not transitive. Schema nodes point directly at the
 * endpoints and generators that read them, so a hop is all the graph requires;
 * a transitive closure over `contains` would reintroduce the same imprecision
 * by a longer route.
 */

import {
  buildDependencyGraph,
  edgeFacet,
  endpointNode,
  entityNode,
  fieldNode,
  relationNode,
  type DependencyEdge,
  type DependencyGraph,
  type EdgeAspect,
  type GraphNode,
} from './graph.js';
import {
  diffSchemas,
  highestRisk,
  type ChangeAspect,
  type ChangeRisk,
  type SchemaChange,
} from './changes.js';
import type { ArtifactType, EndpointRow } from '@instantmockapi/shared';
import type { InternalProjectSchema } from './types.js';

/** Edge kinds a change of each aspect may be followed along. See the table above. */
const ASPECT_EDGES: Record<ChangeAspect, readonly EdgeAspect[]> = {
  read: ['read', 'query'],
  write: ['write'],
  both: ['read', 'write', 'query'],
  routing: ['routing'],
  none: [],
};

/** One reason an endpoint appears in the affected list. */
export interface ImpactReason {
  /** The change that caused it. */
  change: SchemaChange;
  /** Readable source: `User.email`, `User`. */
  source: string;
  /** Precise pointer into the endpoint: `request.body.email`. */
  reason: string;
  /** Which part of the endpoint is touched. */
  facet: 'request' | 'response' | 'query' | 'path';
}

export interface AffectedEndpoint {
  /** Graph node id — `endpoint:PATCH /user/{id}`. */
  id: string;
  method: EndpointRow['method'];
  path: string;
  target: EndpointRow['target'];
  entity?: string;
  /** Every reason, in the order the changes were reported. */
  reasons: ImpactReason[];
  /** Worst risk among the changes reaching this endpoint. */
  risk: ChangeRisk;
}

export interface UnaffectedEndpoint {
  id: string;
  method: EndpointRow['method'];
  path: string;
  target: EndpointRow['target'];
  entity?: string;
}

/**
 * A change that could not be traced to any endpoint, and why.
 *
 * Two honest cases live here, and they are different:
 *
 * - `no-wire` — the change genuinely reaches nothing callable. A description
 *   edit, a generator toggle. Expected, and not a warning.
 * - `unidentified` — the change names a schema element with no stable id, so it
 *   could not be matched to a graph node. This is a *gap in the analysis*, not
 *   a finding about the API, and it happens on any schema not yet run through
 *   `ensureSchemaIds`. Surfacing it is the difference between "nothing is
 *   affected" and "we could not tell".
 */
export interface UnattributedChange {
  change: SchemaChange;
  cause: 'no-wire' | 'unidentified';
}

export interface ImpactReport {
  changes: readonly SchemaChange[];
  affected: AffectedEndpoint[];
  /** Endpoints explicitly confirmed untouched. */
  unaffected: UnaffectedEndpoint[];
  /** Artifacts that need regenerating, as a conservative superset. */
  artifacts: ArtifactType[];
  unattributed: UnattributedChange[];
  /** Worst risk across every change, or null when nothing changed. */
  risk: ChangeRisk | null;
  /**
   * True when the report may be incomplete.
   *
   * Set when any change is `unidentified`. A caller showing a confirmation
   * dialog should say so rather than presenting the unaffected list as a
   * guarantee it cannot make.
   */
  incomplete: boolean;
}

const RISK_RANK: Record<ChangeRisk, number> = {
  INFO: 0,
  SAFE: 1,
  WARNING: 2,
  ROUTING: 3,
  BREAKING: 4,
};

/**
 * Artifacts a removed entity invalidates.
 *
 * All of them: every generator emits something per entity, so a removal changes
 * every output. Listed rather than inferred because the removed entity has no
 * graph node whose edges could be followed. `ips` is excluded for the same
 * reason it is absent from `GENERATOR_INPUTS` — the API owns it.
 */
const REMOVAL_ARTIFACTS: readonly ArtifactType[] = [
  'export_zip',
  'hosted_api',
  'json_schema',
  'mock_data',
  'openapi',
  'postman',
  'typescript',
  'yup',
  'zod',
];

/**
 * Candidate graph nodes for a change, most specific first.
 *
 * The most specific one that **exists in the graph** wins. Both halves matter:
 *
 * - Most specific: a validation change on `User.email` must resolve to the
 *   field, not to `User`, or it would drag every one of the entity's endpoints
 *   in behind it and put DELETE back in the report.
 * - That exists: a *removed* field has no node in the draft graph, because the
 *   draft is the definition it was removed from. Resolving it to the field alone
 *   would report a deletion as affecting nothing. Falling through to the entity
 *   is both available (`diffSchemas` always sets `entityId`) and correct — the
 *   entity's whole surface is restated when a field leaves it.
 */
function changeCandidates(change: SchemaChange): { ids: string[]; identified: boolean } {
  // Most specific first. The caller takes the first that exists in the graph.
  const ids: string[] = [];
  if (change.fieldId !== undefined) {
    ids.push(fieldNode(change.fieldId));
  }
  if (change.relationId !== undefined) {
    ids.push(relationNode(change.relationId));
  }
  if (change.entityId !== undefined) {
    ids.push(entityNode(change.entityId));
  }
  if (ids.length > 0) {
    return { ids, identified: true };
  }

  // Project-level changes (methods, features, generators, record counts) name no
  // schema element by design. They are attributed by kind below rather than by
  // traversal, so absent ids here are expected, not a gap.
  const projectLevel =
    change.kind === 'METHODS_CHANGED' ||
    change.kind === 'QUERY_FEATURES_CHANGED' ||
    change.kind === 'GENERATORS_CHANGED' ||
    change.kind === 'MOCK_RECORDS_CHANGED';
  return { ids: [], identified: projectLevel };
}

function readableSource(node: GraphNode | undefined, change: SchemaChange): string {
  if (node !== undefined) {
    return node.label;
  }
  const parts = [change.entityName, change.fieldName ?? change.relationName].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.join('.');
}

/**
 * Analyse the impact of a set of changes against a graph.
 *
 * The graph must be built from the **draft** definition, not the active one.
 * Impact is a statement about the API the user is about to publish: a field they
 * just added has no node in the active graph, so an active-graph traversal would
 * report a new required field as affecting nothing.
 *
 * One consequence worth stating: a *removal* is the mirror case. A deleted field
 * has no node in the draft graph either, so `FIELD_REMOVED` is attributed to its
 * entity's endpoints rather than traversed from the field. That is handled by
 * `changeNodes` falling through to `entityId`, which `diffSchemas` always sets.
 */
export function analyseImpact(
  changes: readonly SchemaChange[],
  graph: DependencyGraph,
): ImpactReport {
  const affected = new Map<string, AffectedEndpoint>();
  const artifacts = new Set<ArtifactType>();
  const unattributed: UnattributedChange[] = [];

  for (const change of changes) {
    const allowed = ASPECT_EDGES[change.aspect];
    const { ids, identified } = changeCandidates(change);
    // First candidate present in the graph, not all of them: resolving to both
    // the field and its entity would double-report every change.
    const nodeId = ids.find((id) => graph.out.has(id));

    if (!identified) {
      unattributed.push({ change, cause: 'unidentified' });
      continue;
    }
    // A removed entity is the one change with nowhere to land: it has no node in
    // the draft graph, because the draft is the definition it was removed from,
    // and unlike a removed field it has no surviving parent to fall back to. Its
    // own endpoints are genuinely gone rather than changed — but the discovery
    // document that advertised them is served by a URL that still exists, and it
    // has changed. Attributing it there is the whole of the observable impact.
    if (nodeId === undefined && change.kind === 'ENTITY_REMOVED') {
      const catalogue = graph.nodes.get(endpointNode('GET', ''));
      if (catalogue?.endpoint !== undefined) {
        recordEndpoint(affected, catalogue, change, undefined, {
          source: entityNode(change.entityId ?? ''),
          target: catalogue.id,
          aspect: 'routing',
          reason: 'response.entities[].path',
        });
        for (const artifact of REMOVAL_ARTIFACTS) {
          artifacts.add(artifact);
        }
        continue;
      }
    }

    if (allowed.length === 0 || nodeId === undefined) {
      // Either nothing reaches a wire, or the change is project-level. Both are
      // legitimately endpoint-less; project-level changes still touch artifacts,
      // which the block below records.
      unattributed.push({ change, cause: 'no-wire' });
      if (change.kind === 'METHODS_CHANGED' || change.kind === 'QUERY_FEATURES_CHANGED') {
        // The endpoint set or the accepted query string moved for the whole
        // project. Every surface artifact restates it.
        artifacts.add('hosted_api');
        artifacts.add('openapi');
        artifacts.add('postman');
        artifacts.add('export_zip');
      }
      if (change.kind === 'MOCK_RECORDS_CHANGED') {
        artifacts.add('mock_data');
      }
      continue;
    }

    let reached = 0;
    for (const edge of graph.out.get(nodeId) ?? []) {
      if (!allowed.includes(edge.aspect)) {
        continue;
      }
      const target = graph.nodes.get(edge.target);
      if (target === undefined) {
        continue;
      }
      if (target.kind === 'generator' && target.artifact !== undefined) {
        artifacts.add(target.artifact);
        continue;
      }
      if (target.kind !== 'endpoint' || target.endpoint === undefined) {
        continue;
      }
      reached += 1;
      recordEndpoint(affected, target, change, graph.nodes.get(nodeId), edge);
    }

    // Schema generators hang off the entity, not off each field, so a field
    // change reaches `zod` and `typescript` only by walking up. Without this a
    // type change would regenerate the hosted API and leave the emitted types
    // describing the previous shape.
    collectAncestorArtifacts(graph, nodeId, artifacts);

    if (reached === 0) {
      unattributed.push({ change, cause: 'no-wire' });
    }
  }

  // Every affected endpoint's own surface artifacts must be regenerated too.
  // Following the graph rather than assuming keeps this list honest if the
  // generator mapping changes.
  for (const id of affected.keys()) {
    for (const edge of graph.out.get(id) ?? []) {
      const target = graph.nodes.get(edge.target);
      if (target?.kind === 'generator' && target.artifact !== undefined) {
        artifacts.add(target.artifact);
      }
    }
  }

  const unaffected: UnaffectedEndpoint[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'endpoint' || node.endpoint === undefined || affected.has(node.id)) {
      continue;
    }
    unaffected.push(endpointRef(node.id, node.endpoint));
  }

  return {
    changes,
    affected: [...affected.values()].sort(compareEndpoints),
    unaffected: unaffected.sort(compareEndpoints),
    artifacts: [...artifacts].sort(),
    unattributed,
    risk: highestRisk(changes),
    incomplete: unattributed.some((entry) => entry.cause === 'unidentified'),
  };
}

/**
 * Schema-generator artifacts reachable by walking up from a node.
 *
 * Entities carry the `zod`/`typescript`/`mock_data` edges; fields and relations
 * do not. A field-level change therefore has to climb to its entity to find the
 * artifacts that restate its shape. The walk is bounded by the tree depth
 * (field → entity → project) and guarded against a malformed parent cycle.
 */
function collectAncestorArtifacts(
  graph: DependencyGraph,
  nodeId: string,
  artifacts: Set<ArtifactType>,
): void {
  const seen = new Set<string>([nodeId]);
  let current = graph.nodes.get(nodeId)?.parent;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    for (const edge of graph.out.get(current) ?? []) {
      const target = graph.nodes.get(edge.target);
      if (target?.kind === 'generator' && target.artifact !== undefined) {
        artifacts.add(target.artifact);
      }
    }
    current = graph.nodes.get(current)?.parent;
  }
}

function endpointRef(id: string, row: EndpointRow): UnaffectedEndpoint {
  return {
    id,
    method: row.method,
    // The discovery document's path is '' — it *is* the base URL. Normalised the
    // same way the node id is, so a UI never renders a blank path.
    path: row.path === '' ? '/' : row.path,
    target: row.target,
    ...(row.entity !== undefined ? { entity: row.entity } : {}),
  };
}

function recordEndpoint(
  affected: Map<string, AffectedEndpoint>,
  target: GraphNode,
  change: SchemaChange,
  sourceNode: GraphNode | undefined,
  edge: DependencyEdge,
): void {
  const row = target.endpoint;
  if (row === undefined) {
    return;
  }
  const facet = edgeFacet(edge);
  if (facet === null) {
    return;
  }

  let entry = affected.get(target.id);
  if (entry === undefined) {
    entry = { ...endpointRef(target.id, row), reasons: [], risk: change.risk };
    affected.set(target.id, entry);
  }
  if (RISK_RANK[change.risk] > RISK_RANK[entry.risk]) {
    entry.risk = change.risk;
  }

  const reason: ImpactReason = {
    change,
    source: readableSource(sourceNode, change),
    reason: edge.reason,
    facet,
  };
  // A field reaches PATCH along both a write and a read edge, and both are true
  // and worth showing. The same (change, pointer) pair twice is not — that would
  // happen if two edges shared a reason string.
  const seen = entry.reasons.some(
    (existing) => existing.change === change && existing.reason === reason.reason,
  );
  if (!seen) {
    entry.reasons.push(reason);
  }
}

function compareEndpoints(a: UnaffectedEndpoint, b: UnaffectedEndpoint): number {
  return a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path);
}

/**
 * Diff a draft against the active definition and analyse the result in one call.
 *
 * The convenience the API routes and the web editor both want, and the place the
 * "build the graph from the draft" rule is enforced so no caller has to remember
 * it. Both arguments carry their own `generationConfig`, so the graph is built
 * against the config that ships with the draft.
 */
export function analyseDraftImpact(
  active: InternalProjectSchema,
  draft: InternalProjectSchema,
): ImpactReport {
  return analyseImpact(diffSchemas(active, draft), buildDependencyGraph(draft));
}

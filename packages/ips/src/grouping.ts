/**
 * Grouping a flat change list into §37's hierarchy.
 *
 * `diffSchemas` returns a flat array, deliberately — `analyseImpact` iterates
 * it, `summariseChanges` iterates it, and several test files assert on it. This
 * is a second, optional projection over the same array, on the same terms as
 * `classifyImpact`: pure, additive, and never the storage format.
 *
 * ## Why it lives in `packages/ips` and not in the web app
 *
 * Two consumers — the commit review dialog and the version comparison page —
 * and `ARCHITECTURE.md` settles what that means: *"`packages/ips` owns the whole
 * chain… Clients render this. They do not recompute it. A second implementation
 * in the frontend would eventually disagree with the backend about what a change
 * means, and the user would be shown two different answers to the same
 * question."*
 *
 * `apps/web` may not import server packages, so the shape crosses the wire as
 * JSON and the web app restates only the types — exactly the pattern
 * `ChangeRisk` already follows.
 *
 * ## What §37 is actually asking for
 *
 * > Do not display 50 separate flat change rows when they belong to one entity.
 *
 * So: entity → its own changes, its fields, its relations, and the endpoints it
 * reaches. Two things do **not** fit that tree and must not be forced into it:
 *
 * - **Config changes genuinely have no entity.** `METHODS_CHANGED`,
 *   `QUERY_FEATURES_CHANGED`, `MOCK_RECORDS_CHANGED` and `GENERATORS_CHANGED`
 *   carry no `entityName` at all, so they get a project-level group.
 * - **Relation changes *do* have one.** `diffRelations` stamps `entityName` on
 *   every relation change including removals (using the surviving entity), so
 *   they nest under their declaring entity as §37's own example shows.
 *
 * ## Order
 *
 * Document order, never re-sorted by risk or impact. `diffSchemas` promises a
 * stable order and a rendered list that reshuffles between reads is worse than
 * one that is not sorted by severity. Sorting is a UI affordance applied on top.
 */

import type { SchemaChange } from './changes.js';
import {
  classifyChangeType,
  classifyImpact,
  type ChangeImpact,
  type ChangeType,
} from './classification.js';
import type { ImpactReport } from './impact.js';

/** One change, with both projections attached so a renderer computes nothing. */
export interface GroupedChange {
  change: SchemaChange;
  changeType: ChangeType;
  impact: ChangeImpact;
}

export interface ChangeGroupCounts {
  total: number;
  added: number;
  removed: number;
  modified: number;
  renamed: number;
  breaking: number;
  potentiallyBreaking: number;
  nonBreaking: number;
}

/** What happened to a group as a whole, for its `+ − ~` glyph. */
export type GroupStatus = 'added' | 'removed' | 'renamed' | 'modified';

export interface FieldGroup {
  /** Stable React key: the element's id, else its `name:` fallback, else its path. */
  key: string;
  fieldId?: string;
  /** Dotted path as the `to` side spells it — `address.city`. */
  path: string;
  name: string;
  /** Set only when this field was renamed. */
  previousName?: string;
  status: GroupStatus;
  changes: GroupedChange[];
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: 'id' | 'name';
}

export interface RelationGroup {
  key: string;
  relationId?: string;
  name: string;
  previousName?: string;
  status: GroupStatus;
  changes: GroupedChange[];
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: 'id' | 'name';
}

/** An endpoint this entity's changes reach, from the impact report. */
export interface EndpointRef {
  method: string;
  path: string;
}

export interface EntityGroup {
  key: string;
  entityId?: string;
  /** Name on the `to` side; the `from` name for a removed entity. */
  name: string;
  previousName?: string;
  status: GroupStatus;
  /** Changes about the entity itself — rename, description, identity. */
  own: GroupedChange[];
  fields: FieldGroup[];
  relations: RelationGroup[];
  /** §37's "APIs" sub-section. Empty when no impact report was supplied. */
  endpoints: EndpointRef[];
  /** Over `own` plus every field and relation beneath it. */
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: 'id' | 'name';
}

/** Changes belonging to no entity: methods, query features, seeding, generators. */
export interface ProjectGroup {
  changes: GroupedChange[];
  counts: ChangeGroupCounts;
  impact: ChangeImpact | null;
}

export interface ChangeTree {
  /** `to`-document order, then entities that only exist on the `from` side. */
  entities: EntityGroup[];
  project: ProjectGroup;
  /** Over the whole change list. */
  counts: ChangeGroupCounts;
}

/* ────────────────────────── counting ────────────────────────── */

function emptyCounts(): ChangeGroupCounts {
  return {
    total: 0,
    added: 0,
    removed: 0,
    modified: 0,
    renamed: 0,
    breaking: 0,
    potentiallyBreaking: 0,
    nonBreaking: 0,
  };
}

function countInto(counts: ChangeGroupCounts, entry: GroupedChange): void {
  counts.total += 1;
  switch (entry.changeType) {
    case 'ADDED':
      counts.added += 1;
      break;
    case 'REMOVED':
      counts.removed += 1;
      break;
    case 'RENAMED':
      counts.renamed += 1;
      break;
    case 'MODIFIED':
      counts.modified += 1;
      break;
  }
  switch (entry.impact) {
    case 'BREAKING':
      counts.breaking += 1;
      break;
    case 'POTENTIALLY_BREAKING':
      counts.potentiallyBreaking += 1;
      break;
    case 'NON_BREAKING':
      counts.nonBreaking += 1;
      break;
  }
}

function addCounts(into: ChangeGroupCounts, from: ChangeGroupCounts): void {
  into.total += from.total;
  into.added += from.added;
  into.removed += from.removed;
  into.modified += from.modified;
  into.renamed += from.renamed;
  into.breaking += from.breaking;
  into.potentiallyBreaking += from.potentiallyBreaking;
  into.nonBreaking += from.nonBreaking;
}

const IMPACT_RANK: Record<ChangeImpact, number> = {
  NON_BREAKING: 0,
  POTENTIALLY_BREAKING: 1,
  BREAKING: 2,
};

/**
 * A group's impact is the worst beneath it.
 *
 * Read from the counts rather than by re-walking the changes, so a group header
 * can never disagree with the rows it summarises.
 */
function impactOf(counts: ChangeGroupCounts): ChangeImpact {
  if (counts.breaking > 0) {
    return 'BREAKING';
  }
  return counts.potentiallyBreaking > 0 ? 'POTENTIALLY_BREAKING' : 'NON_BREAKING';
}

function worse(a: ChangeImpact, b: ChangeImpact): ChangeImpact {
  return IMPACT_RANK[a] >= IMPACT_RANK[b] ? a : b;
}

/* ────────────────────────── shape ────────────────────────── */

/**
 * What happened to a group, from the kinds beneath it.
 *
 * An addition or a removal outranks everything else — an added entity's other
 * rows are describing something that did not exist a moment ago, so "added" is
 * the honest headline. A rename outranks a plain modification because it is the
 * thing a reader needs to see first.
 */
function statusOf(entries: readonly GroupedChange[], selfKinds: readonly string[]): GroupStatus {
  const own = entries.filter((entry) => selfKinds.includes(entry.change.kind));
  if (own.some((entry) => entry.changeType === 'ADDED')) {
    return 'added';
  }
  if (own.some((entry) => entry.changeType === 'REMOVED')) {
    return 'removed';
  }
  if (own.some((entry) => entry.changeType === 'RENAMED')) {
    return 'renamed';
  }
  return 'modified';
}

const ENTITY_SELF_KINDS = [
  'ENTITY_ADDED',
  'ENTITY_REMOVED',
  'ENTITY_RENAMED',
  'ENTITY_DESCRIPTION_CHANGED',
  'ENTITY_IDENTITY_CHANGED',
] as const;

const FIELD_KINDS = [
  'FIELD_ADDED',
  'FIELD_REMOVED',
  'FIELD_RENAMED',
  'FIELD_TYPE_CHANGED',
  'FIELD_REQUIRED_CHANGED',
  'FIELD_DEFAULT_CHANGED',
  'FIELD_META_CHANGED',
  'VALIDATION_ADDED',
  'VALIDATION_REMOVED',
  'VALIDATION_CHANGED',
  'ENUM_VALUES_ADDED',
  'ENUM_VALUES_REMOVED',
] as const;

const RELATION_KINDS = [
  'RELATION_ADDED',
  'RELATION_REMOVED',
  'RELATION_RENAMED',
  'RELATION_KIND_CHANGED',
  'RELATION_TARGET_CHANGED',
  'RELATION_FIELDS_CHANGED',
  'RELATION_ON_DELETE_CHANGED',
  'RELATION_REQUIRED_CHANGED',
] as const;

const isFieldKind = (kind: string): boolean => (FIELD_KINDS as readonly string[]).includes(kind);
const isRelationKind = (kind: string): boolean =>
  (RELATION_KINDS as readonly string[]).includes(kind);

/** The name a rename came from, if this group contains one. */
function previousNameOf(entries: readonly GroupedChange[]): string | undefined {
  const rename = entries.find((entry) => entry.changeType === 'RENAMED');
  return typeof rename?.change.before === 'string' ? rename.change.before : undefined;
}

/**
 * `'name'` when anything in the group was name-matched.
 *
 * Worst-case rather than first-seen: a group with one uncertain pairing is an
 * uncertain group, and the badge has to reflect that.
 */
function basisOf(entries: readonly GroupedChange[]): 'id' | 'name' {
  return entries.some((entry) => entry.change.matchedBy === 'name') ? 'name' : 'id';
}

/* ────────────────────────── the grouping ────────────────────────── */

/** Kinds whose `path` is the synthetic rule pointer rather than the field's. */
const VALIDATION_RULE_KINDS: ReadonlySet<string> = new Set([
  'VALIDATION_ADDED',
  'VALIDATION_REMOVED',
  'VALIDATION_CHANGED',
]);

/**
 * A field's identity within its entity.
 *
 * The dotted path, not the name: two fields can share a name at different
 * depths (`id` and `address.id`), and grouping on the bare name would merge two
 * unrelated changes under one header.
 *
 * But `diffField` **overwrites** `path` for validation rules with a synthetic
 * pointer — `email.validation.min` — so grouping on it naively splits each rule
 * into its own pseudo-field, which is precisely the flat-row problem §37
 * forbids: a field with a type change and two tightened rules would render as
 * three sibling groups. A rule is a property *of* a field, so it groups under
 * the field it belongs to.
 *
 * Keyed off the change kind rather than off the presence of `.validation.` in
 * the string, so a field genuinely called `validation` is not mis-stripped.
 */
function fieldPathOf(change: SchemaChange): string {
  const path = change.path ?? change.fieldName ?? '';
  if (!VALIDATION_RULE_KINDS.has(change.kind)) {
    return path;
  }
  const at = path.lastIndexOf('.validation.');
  return at === -1 ? path : path.slice(0, at);
}

export function groupChanges(changes: readonly SchemaChange[], impact?: ImpactReport): ChangeTree {
  const decorated: GroupedChange[] = changes.map((change) => ({
    change,
    changeType: classifyChangeType(change),
    impact: classifyImpact(change),
  }));

  const total = emptyCounts();
  for (const entry of decorated) {
    countInto(total, entry);
  }

  // Endpoints an entity reaches, from the impact report's own attribution.
  // Keyed on entity NAME because that is what `AffectedEndpoint` carries.
  const endpointsByEntity = new Map<string, EndpointRef[]>();
  for (const endpoint of impact?.affected ?? []) {
    if (endpoint.entity === undefined) {
      continue;
    }
    const list = endpointsByEntity.get(endpoint.entity) ?? [];
    list.push({ method: endpoint.method, path: endpoint.path });
    endpointsByEntity.set(endpoint.entity, list);
  }

  const projectChanges: GroupedChange[] = [];
  // Insertion-ordered, so entities come out in the order the diff reported them
  // — which is `to`-document order, then `from`-only entities.
  const byEntity = new Map<string, GroupedChange[]>();

  for (const entry of decorated) {
    const name = entry.change.entityName;
    if (name === undefined) {
      projectChanges.push(entry);
      continue;
    }
    const list = byEntity.get(name) ?? [];
    list.push(entry);
    byEntity.set(name, list);
  }

  const entities: EntityGroup[] = [];
  for (const [name, entries] of byEntity) {
    const fieldsByPath = new Map<string, GroupedChange[]>();
    const relationsByName = new Map<string, GroupedChange[]>();
    const own: GroupedChange[] = [];

    for (const entry of entries) {
      if (isFieldKind(entry.change.kind)) {
        const path = fieldPathOf(entry.change);
        const list = fieldsByPath.get(path) ?? [];
        list.push(entry);
        fieldsByPath.set(path, list);
      } else if (isRelationKind(entry.change.kind)) {
        const relation = entry.change.relationName ?? '';
        const list = relationsByName.get(relation) ?? [];
        list.push(entry);
        relationsByName.set(relation, list);
      } else {
        own.push(entry);
      }
    }

    const entityCounts = emptyCounts();
    for (const entry of own) {
      countInto(entityCounts, entry);
    }

    const fields: FieldGroup[] = [];
    for (const [path, group] of fieldsByPath) {
      const counts = emptyCounts();
      for (const entry of group) {
        countInto(counts, entry);
      }
      addCounts(entityCounts, counts);
      const first = group[0]!.change;
      const previous = previousNameOf(group);
      fields.push({
        key: first.fieldId ?? `path:${name}.${path}`,
        ...(first.fieldId === undefined ? {} : { fieldId: first.fieldId }),
        path,
        name: first.fieldName ?? path,
        ...(previous === undefined ? {} : { previousName: previous }),
        status: statusOf(group, FIELD_KINDS),
        changes: group,
        counts,
        impact: impactOf(counts),
        matchedBy: basisOf(group),
      });
    }

    const relations: RelationGroup[] = [];
    for (const [relationName, group] of relationsByName) {
      const counts = emptyCounts();
      for (const entry of group) {
        countInto(counts, entry);
      }
      addCounts(entityCounts, counts);
      const first = group[0]!.change;
      const previous = previousNameOf(group);
      relations.push({
        key: first.relationId ?? `relation:${name}.${relationName}`,
        ...(first.relationId === undefined ? {} : { relationId: first.relationId }),
        name: relationName,
        ...(previous === undefined ? {} : { previousName: previous }),
        status: statusOf(group, RELATION_KINDS),
        changes: group,
        counts,
        impact: impactOf(counts),
        matchedBy: basisOf(group),
      });
    }

    const entityId = entries.find((entry) => entry.change.entityId !== undefined)?.change.entityId;
    const previous = previousNameOf(own);

    entities.push({
      key: entityId ?? `entity:${name}`,
      ...(entityId === undefined ? {} : { entityId }),
      name,
      ...(previous === undefined ? {} : { previousName: previous }),
      status: statusOf(entries, ENTITY_SELF_KINDS),
      own,
      fields,
      relations,
      endpoints: endpointsByEntity.get(name) ?? [],
      counts: entityCounts,
      impact: impactOf(entityCounts),
      matchedBy: basisOf(entries),
    });
  }

  const projectCounts = emptyCounts();
  for (const entry of projectChanges) {
    countInto(projectCounts, entry);
  }

  return {
    entities,
    project: {
      changes: projectChanges,
      counts: projectCounts,
      // `null` rather than NON_BREAKING for an empty group, so a renderer can
      // omit the section instead of showing a reassuring badge over nothing.
      impact: projectChanges.length === 0 ? null : impactOf(projectCounts),
    },
    counts: total,
  };
}

/** The worst impact anywhere in a tree, for §36's header. */
export function treeImpact(tree: ChangeTree): ChangeImpact | null {
  if (tree.counts.total === 0) {
    return null;
  }
  let worst: ChangeImpact = 'NON_BREAKING';
  for (const entity of tree.entities) {
    worst = worse(worst, entity.impact);
  }
  if (tree.project.impact !== null) {
    worst = worse(worst, tree.project.impact);
  }
  return worst;
}

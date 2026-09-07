/**
 * One serializer for a `SchemaChange`, shared by both things that send them.
 *
 * The commit dialog (`GET /draft/impact`) and the comparison endpoint
 * (`GET /versions/compare`) describe the same objects. Two mappers would drift,
 * and the drift would be invisible until a screen showed a field the other
 * screen did not — so there is one, and both call it.
 *
 * ## Additive, so nothing that reads the old shape breaks
 *
 * Every field the draft payload carried is still there, spelled the same way.
 * The Phase 2 additions — stable ids, the four-way `changeType`, the three-value
 * `impact`, and `matchedBy` — are new keys beside them. `review-changes.tsx`
 * needs no edit at all, and the ids it never had are what let the comparison
 * page group rows by element rather than by name.
 *
 * ## Why `field` keeps a known flaw
 *
 * `field: fieldName ?? relationName` conflates a field change and a relation
 * change into one key. It is kept for compatibility, and it is exactly why
 * `groupChanges` keys on `fieldId`/`relationId`/`relationName` and never on the
 * serialized `field`.
 *
 * ## Payload capping lives here, not in `packages/ips`
 *
 * `before`/`after` are `unknown` and can be arbitrarily large — a `default` on
 * an object-typed field is effectively unbounded. Truncating is a presentation
 * concern, and `changes.ts` must stay a pure function of two schemas with no
 * limits baked in.
 */

import {
  classifyChangeType,
  classifyImpact,
  type ChangeTree,
  type GroupedChange,
  type ImpactReport,
  type MatchingReport,
  type SchemaChange,
} from '@instantmockapi/ips';

/**
 * Values above this serialize as a marker with a preview.
 *
 * Generous enough that no realistic field payload is touched — a type name, a
 * boolean, a bound, an enum list — and small enough that one pathological
 * default cannot dominate a response.
 */
const MAX_VALUE_BYTES = 2_048;

export interface TruncatedValue {
  __truncated: true;
  preview: string;
  bytes: number;
}

/** Cap one `before`/`after` value, leaving anything reasonable untouched. */
export function capValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  // Cheap guard first: only strings and objects can be large, and stringifying
  // every boolean to measure it would be wasteful on the common path.
  if (typeof value !== 'string' && typeof value !== 'object') {
    return value;
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? '';
  } catch {
    // A cyclic value cannot come from a stored IPS, but this runs over
    // `Schema.Types.Mixed` and must not throw on the way out.
    return { __truncated: true, preview: '[unserializable]', bytes: 0 } satisfies TruncatedValue;
  }

  if (encoded.length <= MAX_VALUE_BYTES) {
    return value;
  }
  return {
    __truncated: true,
    preview: `${encoded.slice(0, 200)}…`,
    bytes: encoded.length,
  } satisfies TruncatedValue;
}

/** One change on the wire. */
export function toChangeView(change: SchemaChange): Record<string, unknown> {
  return {
    // ── unchanged from the Phase 1 payload, spelled identically ──
    kind: change.kind,
    risk: change.risk,
    aspect: change.aspect,
    entity: change.entityName ?? null,
    field: change.fieldName ?? change.relationName ?? null,
    path: change.path ?? null,
    before: capValue(change.before),
    after: capValue(change.after),
    summary: change.summary,

    // ── Phase 2, additive ──
    // The stable ids §43 requires, and §37's grouping needs. None of these
    // crossed the wire before, so the client only ever had names to key on.
    entityId: change.entityId ?? null,
    fieldId: change.fieldId ?? null,
    relationId: change.relationId ?? null,
    relationName: change.relationName ?? null,
    // Both projections, computed once here rather than in two clients.
    changeType: classifyChangeType(change),
    impact: classifyImpact(change),
    // `'id'` unless the two sides had to be paired by name — see `MatchingReport`.
    matchedBy: change.matchedBy ?? 'id',
  };
}

function toGroupedChangeView(entry: GroupedChange): Record<string, unknown> {
  return {
    change: toChangeView(entry.change),
    changeType: entry.changeType,
    impact: entry.impact,
  };
}

/**
 * How many changes any one entity group may carry on the wire.
 *
 * Capped **per entity**, not globally from the tail. A global truncation makes
 * the last entities vanish entirely; this way every entity stays visible with an
 * honest "+340 more in this entity" affordance.
 *
 * The worst case is ordinary rather than adversarial: v1 of one design against
 * v9 after a re-parse shares nothing, and `validateIPS` caps neither entity nor
 * field count — so an uncapped response is megabytes of changes nobody can read.
 */
const MAX_CHANGES_PER_ENTITY = 100;

export interface TreeTruncation {
  omittedChanges: number;
  omittedEntities: number;
}

/**
 * The change tree on the wire, with the counts computed over the FULL set.
 *
 * The counts are never capped — that is the whole discipline here. The header
 * says "412 changes, 2 breaking" truthfully even when the body below it shows a
 * hundred of them, and `truncated` is non-null whenever anything was dropped so
 * the UI can say so rather than silently eliding.
 */
export function toChangeTreeView(
  tree: ChangeTree,
  maxChanges: number,
): { tree: Record<string, unknown>; truncated: TreeTruncation | null } {
  let budget = maxChanges;
  let omittedChanges = 0;
  let omittedEntities = 0;

  const entities: Record<string, unknown>[] = [];

  for (const entity of tree.entities) {
    if (budget <= 0) {
      omittedEntities += 1;
      omittedChanges += entity.counts.total;
      continue;
    }

    const perEntity = Math.min(MAX_CHANGES_PER_ENTITY, budget);
    let used = 0;
    let dropped = 0;

    /** Take from a group until this entity's allowance runs out. */
    const take = <T>(items: readonly T[], size: (item: T) => number, render: (item: T) => T) => {
      const kept: T[] = [];
      for (const item of items) {
        const cost = size(item);
        if (used + cost > perEntity) {
          dropped += cost;
          continue;
        }
        used += cost;
        kept.push(render(item));
      }
      return kept;
    };

    const own = take(
      entity.own,
      () => 1,
      (entry) => entry,
    ).map(toGroupedChangeView);

    const fields = take(
      entity.fields,
      (group) => group.counts.total,
      (group) => group,
    ).map((group) => ({
      key: group.key,
      fieldId: group.fieldId ?? null,
      path: group.path,
      name: group.name,
      previousName: group.previousName ?? null,
      status: group.status,
      counts: group.counts,
      impact: group.impact,
      matchedBy: group.matchedBy,
      changes: group.changes.map(toGroupedChangeView),
    }));

    const relations = take(
      entity.relations,
      (group) => group.counts.total,
      (group) => group,
    ).map((group) => ({
      key: group.key,
      relationId: group.relationId ?? null,
      name: group.name,
      previousName: group.previousName ?? null,
      status: group.status,
      counts: group.counts,
      impact: group.impact,
      matchedBy: group.matchedBy,
      changes: group.changes.map(toGroupedChangeView),
    }));

    budget -= used;
    omittedChanges += dropped;

    entities.push({
      key: entity.key,
      entityId: entity.entityId ?? null,
      name: entity.name,
      previousName: entity.previousName ?? null,
      status: entity.status,
      // Uncapped: the entity's real totals, whatever survived below.
      counts: entity.counts,
      impact: entity.impact,
      matchedBy: entity.matchedBy,
      endpoints: entity.endpoints,
      own,
      fields,
      relations,
      omittedChanges: dropped,
    });
  }

  return {
    tree: {
      entities,
      project: {
        changes: tree.project.changes.map(toGroupedChangeView),
        counts: tree.project.counts,
        impact: tree.project.impact,
      },
      counts: tree.counts,
    },
    truncated:
      omittedChanges === 0 && omittedEntities === 0 ? null : { omittedChanges, omittedEntities },
  };
}

/** The affected/unaffected endpoint lists and the artifact set (§16). */
export function toImpactView(impact: ImpactReport): Record<string, unknown> {
  return {
    affected: impact.affected.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      entity: endpoint.entity ?? null,
      risk: endpoint.risk,
      reasons: endpoint.reasons.map((reason) => ({
        source: reason.source,
        reason: reason.reason,
        facet: reason.facet,
        change: reason.change.kind,
        summary: reason.change.summary,
      })),
    })),
    unaffected: impact.unaffected.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      entity: endpoint.entity ?? null,
    })),
    artifacts: impact.artifacts,
    incomplete: impact.incomplete,
  };
}

/** The matching report, verbatim — the UI decides how loudly to say it. */
export function toMatchingView(matching: MatchingReport): Record<string, unknown> {
  return {
    byId: matching.byId,
    byName: matching.byName,
    nameMatchedEntities: matching.nameMatchedEntities,
    renamesUndetectable: matching.renamesUndetectable,
    legacyBothSides: matching.legacyBothSides,
  };
}

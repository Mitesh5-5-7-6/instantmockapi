/**
 * Comparing two version snapshots (Phase 2 §24).
 *
 * `diffSchemas` already compares two `InternalProjectSchema` documents, and
 * `Version.ipsSnapshot` *is* one — so the types line up and this module exists
 * for something else: four normalisations, each of which is a wrong answer if
 * skipped.
 *
 * | Normalisation | What goes wrong without it |
 * | --- | --- |
 * | overlay `configSnapshot` | `ipsSnapshot.generationConfig` can be a step behind, so config changes are reported against a stale copy |
 * | `materializeRelations` both sides | a pre-relations snapshot has no identity or foreign-key fields, so every entity reports `FIELD_ADDED id` |
 * | deep-clone first | `ensureSchemaIds` mutates and the input is a live mongoose document; §47 forbids touching history |
 * | **never** `ensureSchemaIds` | independently minted ids cannot match, turning every element into a removal plus an addition |
 *
 * ## The id-less snapshot problem
 *
 * Snapshots written before Phase 1's backfill carry no `ent_`/`fld_`/`rel_`
 * ids, and there are exactly three ways to compare two of them:
 *
 * 1. **Ids only** — reports *nothing*, because unidentified elements are
 *    skipped on both sides. A comparison view renders that as "no changes
 *    detected", which is a confident lie.
 * 2. **Mint ids first** — every element becomes a removal plus an addition.
 *    A worse lie, because it is loud.
 * 3. **Fall back to names** — structural changes are accurate; renames are
 *    undetectable and surface as one removal plus one addition.
 *
 * Only the third is honest, and it is only honest if it *says so*. Hence
 * `MatchingReport`, and hence the rule that a rename in a name-matched scope is
 * reported as a removal and an addition rather than guessed at. There is no
 * heuristic rename detection here and there must not be: a guessed rename
 * downgrades a BREAKING remove+add to a ROUTING rename, and guessing wrong
 * hides an outage behind a reassuring label.
 *
 * Backfilling ids into the stored `Version` rows is also not the answer, in any
 * variant. It mutates history (§47), freshly minted ids still would not match
 * the live project's, and the result would be name matching that *looks*
 * id-matched — the lie made permanent and undetectable.
 */

import { diffSchemas, type MatchMode, type SchemaChange } from './changes.js';
import { buildDependencyGraph } from './graph.js';
import { analyseImpact, type ImpactReport } from './impact.js';
import { materializeRelations } from './relations.js';
import type { Entity, GenerationConfig, InternalProjectSchema } from './types.js';

/** One side of a comparison: a stored version, or the live definition. */
export interface SchemaSnapshot {
  version: number;
  /** `Version.ipsSnapshot`, or `project.ips`. */
  ips: InternalProjectSchema;
  /**
   * `Version.configSnapshot`, when there is one.
   *
   * **Authoritative over `ips.generationConfig`.** `createGenerationJob` writes
   * the snapshot's `ipsSnapshot` and `configSnapshot` together and then assigns
   * `project.generationConfig` *without* touching `project.ips` — so the config
   * embedded in the IPS is whatever it held at an earlier moment. Diffing
   * against that produces wrong `METHODS_CHANGED` / `QUERY_FEATURES_CHANGED` /
   * `GENERATORS_CHANGED` results.
   */
  config?: GenerationConfig | undefined;
}

export interface CompareOptions {
  /**
   * Defaults to `'auto'` — the opposite of `diffSchemas`, deliberately.
   *
   * A draft is guaranteed to carry ids on both sides because `POST /draft`
   * backfills first, so `'id'` is right there. A historical snapshot carries
   * whatever it carried when it was written, so `'auto'` is right here.
   */
  match?: MatchMode;
  /** Off only for tests that want the raw stored shape. Defaults to true. */
  materialize?: boolean;
}

/** How much of this comparison rested on names rather than on stable ids. */
export interface MatchingReport {
  /** Element pairs resolved by stable id. */
  byId: number;
  /** Element pairs resolved by name, because one or both sides had none. */
  byName: number;
  /** Entities (named as the `to` side spells them) that were paired by name. */
  nameMatchedEntities: string[];
  /**
   * True when name matching was used anywhere.
   *
   * The consequence a UI must state: within a name-matched scope a rename is
   * reported as one removal plus one addition, because with no stable id the two
   * are indistinguishable.
   */
  renamesUndetectable: boolean;
  /**
   * Neither side carried a single stable id — both snapshots predate the
   * backfill and the whole structural comparison rests on names. The strongest
   * form of the warning, and the one that must appear at page level.
   */
  legacyBothSides: boolean;
}

export interface SchemaDiff {
  from: number;
  to: number;
  /**
   * Whether `to` is newer than `from`.
   *
   * Purely presentational — the algorithm is symmetric — but load-bearing for
   * honesty. A backward pair is the user browsing history, so "3 endpoints
   * affected" is a claim about a hypothetical: the heading should read *"if you
   * restored v2, these APIs would change"*, not *"these APIs are affected"*.
   */
  direction: 'forward' | 'backward';
  changes: SchemaChange[];
  matching: MatchingReport;
}

/* ────────────────────────── normalisation ────────────────────────── */

/**
 * A structural copy, so nothing downstream can write through to a stored
 * document.
 *
 * `JSON` round-trip rather than `structuredClone`: an IPS is JSON by
 * construction (it is persisted as `Schema.Types.Mixed`), and this also strips
 * the mongoose document wrapper that `Version.ipsSnapshot` arrives inside.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The comparable form of one side.
 *
 * Note what is deliberately *not* normalised: `diffSchemas` reads only
 * `generationConfig` and `entities`, so `projectId`, `version`, `publicId` and
 * `slug` are never compared and copying them across would be noise.
 */
function normalise(snapshot: SchemaSnapshot, materialize: boolean): InternalProjectSchema {
  const copy = clone(snapshot.ips);
  const withConfig: InternalProjectSchema = {
    ...copy,
    generationConfig: snapshot.config ?? copy.generationConfig,
  };
  return materialize ? materializeRelations(withConfig) : withConfig;
}

/** Whether a document carries any stable id at all. */
function hasAnyId(ips: InternalProjectSchema): boolean {
  return (ips.entities ?? []).some(
    (entity: Entity) =>
      entity.id !== undefined ||
      (entity.fields ?? []).some((field) => field.id !== undefined) ||
      (entity.relations ?? []).some((relation) => relation.id !== undefined),
  );
}

/**
 * Read the matching basis back off the changes.
 *
 * Derived rather than threaded out of `diffSchemas`, so the diff stays a plain
 * `SchemaChange[]` that every existing caller can keep consuming — and so there
 * is exactly one definition of "was this name-matched": the `matchedBy` on the
 * change itself.
 */
function reportMatching(
  changes: readonly SchemaChange[],
  fromHasIds: boolean,
  toHasIds: boolean,
): MatchingReport {
  let byId = 0;
  let byName = 0;
  const nameMatched = new Set<string>();

  for (const change of changes) {
    if (change.matchedBy === 'name') {
      byName += 1;
      if (change.entityName !== undefined) {
        nameMatched.add(change.entityName);
      }
    } else {
      byId += 1;
    }
  }

  return {
    byId,
    byName,
    nameMatchedEntities: [...nameMatched].sort(),
    renamesUndetectable: byName > 0,
    // Both sides id-less is a property of the DOCUMENTS, not of the changes —
    // two identical legacy snapshots produce no changes at all, and the warning
    // still has to appear so "no differences" is not read as certainty.
    legacyBothSides: !fromHasIds && !toHasIds,
  };
}

/* ────────────────────────── the comparison ────────────────────────── */

/** Every change between two version snapshots. */
export function diffSnapshots(
  from: SchemaSnapshot,
  to: SchemaSnapshot,
  options: CompareOptions = {},
): SchemaDiff {
  const materialize = options.materialize ?? true;
  const before = normalise(from, materialize);
  const after = normalise(to, materialize);

  const changes = diffSchemas(before, after, { match: options.match ?? 'auto' });

  return {
    from: from.version,
    to: to.version,
    direction: to.version >= from.version ? 'forward' : 'backward',
    changes,
    matching: reportMatching(changes, hasAnyId(before), hasAnyId(after)),
  };
}

/**
 * The diff plus its impact, with the graph-side rule enforced in one place.
 *
 * **The graph is built from `to`. Always, with no special case for direction.**
 * `analyseDraftImpact` states the rule for the draft path — the graph must come
 * from the definition that will exist afterwards, because a removed element has
 * no node in it and is attributed to its surviving parent instead. That
 * reasoning is about before-versus-after, not older-versus-newer, so it holds
 * unchanged for a backward pair like `v4 → v2`:
 *
 *   - `to = v2` is what would exist, so an entity present in v4 and absent in v2
 *     is correctly a removal.
 *   - `unaffected` is only meaningful against the endpoint set that would exist,
 *     and v2's is the right denominator.
 *   - `v4 → v2` *is* what rolling back to v2 does — so this makes the impact
 *     report the rollback impact report, for free.
 *
 * The config is overlaid on that side too, because `config.methods` and
 * `config.features` decide which endpoints exist at all; passing the stale
 * embedded copy would enumerate the wrong ones.
 */
export function compareSnapshots(
  from: SchemaSnapshot,
  to: SchemaSnapshot,
  options: CompareOptions = {},
): { diff: SchemaDiff; impact: ImpactReport } {
  const diff = diffSnapshots(from, to, options);
  const target = normalise(to, options.materialize ?? true);
  const graph = buildDependencyGraph(target, target.generationConfig);

  return { diff, impact: analyseImpact(diff.changes, graph) };
}

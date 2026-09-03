/**
 * Routing a server error path back to the form control that caused it.
 *
 * The API answers a failed generate with paths into the document it was sent:
 *
 *     entities[1].fields[1].name  →  "Field name must be alphanumeric…"
 *     entities[2].name            →  "Entity name is invalid"
 *
 * Those indices are positions in the **payload**, not in the form's arrays, and
 * the two are not the same list:
 *
 * - the project wizard sends `pruneForGeneration(entities)` and then
 *   `.filter(field => field.name.trim())`, so excluded entities and half-typed
 *   rows shift every index after them;
 * - the editor's `applyBuilderToIps` drops nameless entities and **reorders
 *   fields** — identity first, authored next, foreign keys last — so
 *   `fields[0]` is usually the identity field, which the form does not render at
 *   all.
 *
 * Matching on names would be wrong for the case that matters most: the field is
 * being rejected *because* its name is invalid, and two entities can be
 * mid-rename to the same string. Matching on index alone would attach an error
 * to whichever unrelated field happens to sit at that position.
 *
 * So the payload builder emits an index as it builds, mapping each path prefix
 * it writes to the builder node it wrote it from. Built in the same pass as the
 * payload, the two cannot drift.
 *
 * ## Failing to map is a real answer
 *
 * A path into a pruned entity, a path at a field the form hides, or a path like
 * `generationConfig.methods` that names no field at all — each comes back as
 * *unmapped* rather than being attached to the nearest plausible control.
 * Pointing at the wrong field is worse than pointing at none: the user edits
 * something that was never broken and the error does not clear.
 */

import type { FailureDetail } from './errors';

/** One step of a path: a key, and an array index when the key was indexed. */
export interface PathSegment {
  key: string;
  index: number | null;
}

/**
 * Path prefix → the id of the builder node written at that position.
 *
 * Keys are canonical prefixes as `formatPath` produces them
 * (`entities[1].fields[1]`); values are `BuilderEntity.id` /
 * `BuilderField.id` / `BuilderRelation.id` — the form's own React keys, not the
 * stable `ent_`/`fld_` schema ids, because the form is what has to highlight
 * something.
 */
export type FieldPathIndex = ReadonlyMap<string, string>;

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d+\])*)$/;

/**
 * Split a dotted, bracketed path into segments.
 *
 * Returns `[]` for anything that is not a path we could have produced, which the
 * caller treats as unmappable. Being strict here is deliberate: these strings
 * arrive over the wire, and a permissive parser would invent segments and
 * mis-attribute an error to a real field.
 */
export function parseErrorPath(path: string): PathSegment[] {
  if (path.trim() === '') {
    return [];
  }
  const segments: PathSegment[] = [];
  for (const raw of path.split('.')) {
    const match = SEGMENT.exec(raw);
    if (match === null) {
      return [];
    }
    const [, key, brackets] = match;
    const indices = brackets === undefined || brackets === '' ? [] : [...brackets.matchAll(/\d+/g)];
    if (indices.length === 0) {
      segments.push({ key: key!, index: null });
      continue;
    }
    // `a[0][1]` is a nested array. Each index becomes its own step so a prefix
    // can stop between them, which is what makes longest-prefix matching work.
    segments.push({ key: key!, index: Number(indices[0]![0]) });
    for (const extra of indices.slice(1)) {
      segments.push({ key: '', index: Number(extra[0]) });
    }
  }
  return segments;
}

/** Rebuild the canonical string for a run of segments. */
export function formatPath(segments: readonly PathSegment[]): string {
  return segments
    .map((segment, position) => {
      const suffix = segment.index === null ? '' : `[${segment.index}]`;
      if (segment.key === '') {
        return suffix;
      }
      return position === 0 ? `${segment.key}${suffix}` : `.${segment.key}${suffix}`;
    })
    .join('');
}

/**
 * Every prefix of a path, longest first.
 *
 * Longest first because the index holds entries at several depths at once:
 * `entities[1].fields[1].name` must resolve to the field, not to the entity that
 * contains it, or a bad field name would highlight the whole entity.
 */
function prefixesLongestFirst(path: string): string[] {
  const segments = parseErrorPath(path);
  const prefixes: string[] = [];
  for (let length = segments.length; length > 0; length -= 1) {
    prefixes.push(formatPath(segments.slice(0, length)));
  }
  return prefixes;
}

/**
 * Builder id a path belongs to, or null when nothing in the form owns it.
 *
 * Resolves to the **deepest indexed prefix**, which means an unknown leaf climbs
 * to its nearest indexed ancestor rather than resolving to nothing. An error on
 * a field the form hides — the editor's identity field, a foreign key — lands on
 * the entity card: less precise, still honest, and still where the problem is.
 *
 * What it will never do is resolve sideways. Attaching an error to a sibling
 * field because that one happens to exist would point at a control the user can
 * edit, that was never broken, and whose message will not clear however they
 * change it.
 */
export function resolvePath(path: string, index: FieldPathIndex): string | null {
  for (const prefix of prefixesLongestFirst(path)) {
    const owner = index.get(prefix);
    if (owner !== undefined) {
      return owner;
    }
  }
  return null;
}

export interface ResolvedDetails {
  /** Builder node id → the messages to show beneath it. */
  mapped: Map<string, string[]>;
  /** Details that name nothing the form renders. These belong in a toast. */
  unmapped: FailureDetail[];
}

/**
 * Split server details into what the form can show and what it cannot.
 *
 * Both halves matter. The mapped half becomes inline field errors; the unmapped
 * half is why the summarising toast still has to exist, because a validation
 * failure can name something the user cannot see.
 */
export function resolveDetails(
  details: readonly FailureDetail[],
  index: FieldPathIndex,
): ResolvedDetails {
  const mapped = new Map<string, string[]>();
  const unmapped: FailureDetail[] = [];

  for (const detail of details) {
    const owner = resolvePath(detail.path, index);
    if (owner === null) {
      unmapped.push(detail);
      continue;
    }
    const existing = mapped.get(owner);
    if (existing === undefined) {
      mapped.set(owner, [detail.issue]);
    } else if (!existing.includes(detail.issue)) {
      // Two rules can reject one field; both are worth showing, but the same
      // rule reported twice is not.
      existing.push(detail.issue);
    }
  }

  return { mapped, unmapped };
}

/**
 * Accumulates the index while a payload is built.
 *
 * A tiny class rather than a bare Map so the builder can push and pop path
 * segments as it descends, instead of every call site assembling
 * `entities[${i}].fields[${j}]` by hand — which is the kind of duplicated string
 * formatting that drifts from `formatPath` the first time a shape changes.
 */
export class PathIndexBuilder {
  private readonly entries = new Map<string, string>();
  private readonly stack: PathSegment[] = [];

  /** Run `body` with one more segment on the path. */
  at<T>(key: string, index: number | null, body: () => T): T {
    this.stack.push({ key, index });
    try {
      return body();
    } finally {
      this.stack.pop();
    }
  }

  /** Claim the current path for a builder node. */
  claim(id: string): void {
    if (this.stack.length > 0) {
      this.entries.set(formatPath(this.stack), id);
    }
  }

  build(): FieldPathIndex {
    return new Map(this.entries);
  }
}

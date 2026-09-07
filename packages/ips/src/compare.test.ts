import { describe, it, expect } from 'vitest';

import { compareSnapshots, diffSnapshots, type SchemaSnapshot } from './compare.js';
import { ensureSchemaIds } from './ids.js';
import { materializeRelations } from './relations.js';
import type { Entity, Field, GenerationConfig, InternalProjectSchema } from './types.js';

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

const config = (over: Partial<GenerationConfig> = {}): GenerationConfig => ({
  validators: ['zod'],
  types: ['typescript'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  mockRecords: 10,
  features: { search: true, filter: true, sort: true, include: true },
  ...over,
});

function ips(entities: Entity[], over: Partial<GenerationConfig> = {}): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities,
    generationConfig: config(over),
  } as InternalProjectSchema;
}

/** A snapshot as `createGenerationJob` writes it: ids minted, relations materialized. */
function modern(version: number, entities: Entity[], over: Partial<GenerationConfig> = {}) {
  const materialized = materializeRelations(ips(entities, over));
  ensureSchemaIds(materialized);
  return { version, ips: materialized, config: materialized.generationConfig } as SchemaSnapshot;
}

/** A snapshot from before the Phase 1 id backfill: no `ent_`/`fld_` anywhere. */
function legacy(version: number, entities: Entity[], over: Partial<GenerationConfig> = {}) {
  return { version, ips: ips(entities, over), config: config(over) } as SchemaSnapshot;
}

const kinds = (diff: { changes: { kind: string }[] }) => diff.changes.map((c) => c.kind).sort();

describe('comparing two modern snapshots', () => {
  it('reports a field type change and nothing else', () => {
    const before = modern(3, [entity('User', [field('email'), field('age')])]);
    const after = modern(4, [entity('User', [field('email'), field('age', { type: 'integer' })])]);
    // Same authored shape, so ids differ between the two independently-minted
    // snapshots — which is exactly the situation `match: 'auto'` exists for.
    const diff = diffSnapshots(before, after);

    expect(diff.changes.some((change) => change.kind === 'FIELD_TYPE_CHANGED')).toBe(true);
    expect(diff.from).toBe(3);
    expect(diff.to).toBe(4);
    expect(diff.direction).toBe('forward');
  });

  it('reports no changes for two snapshots of the same definition', () => {
    const entities = [entity('User', [field('email')])];
    expect(diffSnapshots(modern(3, entities), modern(4, entities)).changes).toEqual([]);
  });

  it('marks a backward pair, so a hypothetical is not presented as a fact', () => {
    const diff = diffSnapshots(
      modern(4, [entity('User', [field('email')])]),
      modern(2, [entity('User', [field('email')])]),
    );
    expect(diff.direction).toBe('backward');
  });
});

describe('the config overlay', () => {
  /**
   * `createGenerationJob` writes `ipsSnapshot` and `configSnapshot` together and
   * then assigns `project.generationConfig` without touching `project.ips` — so
   * the config embedded in the IPS can be a step behind. Diffing against the
   * embedded copy reports the wrong config changes, or misses them entirely.
   */
  it('diffs against configSnapshot, not the stale copy inside ipsSnapshot', () => {
    const base = modern(3, [entity('User', [field('email')])], { methods: ['GET'] });

    // The stored shape: `configSnapshot` says GET+POST, the embedded copy still
    // says GET. The snapshot's real config is the former.
    const skewed: SchemaSnapshot = {
      version: 4,
      ips: base.ips,
      config: config({ methods: ['GET', 'POST'] }),
    };

    const withOverlay = diffSnapshots(base, skewed);
    expect(withOverlay.changes.some((change) => change.kind === 'METHODS_CHANGED')).toBe(true);

    // Without the overlay both sides read `GET` from the IPS and the change
    // vanishes — the bug this normalisation exists to prevent.
    const embeddedOnly = diffSnapshots(base, { version: 4, ips: base.ips });
    expect(embeddedOnly.changes).toEqual([]);
  });

  it('falls back to the embedded config when no configSnapshot was stored', () => {
    const before = modern(1, [entity('User', [field('email')])], { mockRecords: 5 });
    const after = modern(2, [entity('User', [field('email')])], { mockRecords: 50 });

    const diff = diffSnapshots({ version: 1, ips: before.ips }, { version: 2, ips: after.ips });
    expect(diff.changes.some((change) => change.kind === 'MOCK_RECORDS_CHANGED')).toBe(true);
  });
});

describe('materialization', () => {
  /**
   * A snapshot taken before relations existed has no identity field and no
   * foreign keys. Compared raw against a modern one, every entity reports
   * `FIELD_ADDED id` and `FIELD_ADDED <fk>` — a dozen phantom additions.
   */
  it('does not report the derived identity field as an addition', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = modern(2, [entity('User', [field('email')])]);

    const diff = diffSnapshots(before, after);
    const added = diff.changes.filter((change) => change.kind === 'FIELD_ADDED');
    expect(added.map((change) => change.fieldName)).toEqual([]);
  });

  it('reports the phantom additions when materialization is turned off', () => {
    // Pins why the normalisation is on by default.
    const before: SchemaSnapshot = { version: 1, ips: ips([entity('User', [field('email')])]) };
    const after = modern(2, [entity('User', [field('email')])]);

    const raw = diffSnapshots(before, after, { materialize: false });
    expect(raw.changes.some((change) => change.fieldName === 'id')).toBe(true);
  });
});

describe('two id-less snapshots', () => {
  /**
   * The sharpest edge, and the reason `match: 'auto'` is the default here.
   *
   * Under ids-only these diff to **nothing**, and a comparison view renders that
   * as "no changes detected between these versions" — confidently, invisibly
   * wrong.
   */
  it('would report nothing at all under ids-only matching', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('email', { type: 'integer' })])]);

    // The lie this module exists to prevent, pinned so nobody restores it.
    expect(diffSnapshots(before, after, { match: 'id' }).changes).toEqual([]);
  });

  it('finds the real change by falling back to names', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('email', { type: 'integer' })])]);

    const diff = diffSnapshots(before, after);
    expect(kinds(diff)).toContain('FIELD_TYPE_CHANGED');
  });

  it('says the comparison rested on names, and that renames are undetectable', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('email', { type: 'integer' })])]);

    const { matching } = diffSnapshots(before, after);
    expect(matching.byName).toBeGreaterThan(0);
    expect(matching.renamesUndetectable).toBe(true);
    expect(matching.legacyBothSides).toBe(true);
    expect(matching.nameMatchedEntities).toEqual(['User']);
  });

  it('flags legacyBothSides even when there are no changes to report', () => {
    // Two identical legacy snapshots produce no changes, and the warning must
    // still appear — otherwise "no differences" reads as certainty when the
    // comparison could not have detected a rename in the first place.
    const entities = [entity('User', [field('email')])];
    const { matching } = diffSnapshots(legacy(1, entities), legacy(2, entities));

    expect(matching.byName).toBe(0);
    expect(matching.legacyBothSides).toBe(true);
  });

  it('reports a rename as a removal plus an addition, and does not guess', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('emailAddress')])]);

    const diff = diffSnapshots(before, after);
    // No heuristic rename detection — no edit distance, no structural
    // similarity. A guessed rename would downgrade a BREAKING remove+add to a
    // ROUTING rename, and guessing wrong hides an outage behind a
    // reassuring label.
    expect(kinds(diff)).toEqual(['FIELD_ADDED', 'FIELD_REMOVED']);
    expect(diff.changes.some((change) => change.kind === 'FIELD_RENAMED')).toBe(false);
  });

  it('detects an added and a removed entity by name', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('Order', [field('total')])]);

    expect(kinds(diffSnapshots(before, after))).toEqual(['ENTITY_ADDED', 'ENTITY_REMOVED']);
  });
});

describe('a partially identified snapshot', () => {
  /**
   * The common case, not an exotic one: `materializeRelations` regenerates the
   * identity field and every derived foreign key with **no id**, on both sides.
   * So even a fully backfilled project has unidentified elements the moment it
   * is materialized for comparison.
   */
  it('does not report the derived, id-less fields as added', () => {
    const before = modern(3, [
      entity('Order', [field('total')], {
        relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
      }),
      entity('User', [field('email')]),
    ]);
    const after = modern(4, [
      entity('Order', [field('total', { type: 'decimal' })], {
        relations: [{ name: 'buyer', kind: 'belongsTo', target: 'User' }],
      }),
      entity('User', [field('email')]),
    ]);

    const diff = diffSnapshots(before, after);
    // `id` and `userId` exist on both sides with no id of their own. Paired by
    // path, they are silent; unpaired they would each be an addition.
    expect(diff.changes.filter((change) => change.kind === 'FIELD_ADDED')).toEqual([]);
    expect(diff.changes.map((change) => change.kind)).toEqual(['FIELD_TYPE_CHANGED']);
  });

  it('pairs fields on the dotted path, so a nested id never matches the identity', () => {
    const nested = (type: Field['type']) =>
      entity('User', [
        field('email'),
        field('address', {
          type: 'object',
          children: [field('id', { type })],
        }),
      ]);

    const diff = diffSnapshots(legacy(1, [nested('string')]), legacy(2, [nested('integer')]));

    // `address.id` changed. If pairing used the bare name, it would have matched
    // the entity's own `id` — a different field entirely.
    const typeChange = diff.changes.find((change) => change.kind === 'FIELD_TYPE_CHANGED');
    expect(typeChange?.path).toBe('address.id');
  });
});

describe('name-matched changes still resolve in the dependency graph', () => {
  /**
   * The reason the fallback key is `name:<…>` and not something of this module's
   * own invention.
   *
   * `graph.ts` already mints `entity:name:User` / `field:name:User.email` for
   * unidentified elements. `changeCandidates` turns a change's ids into graph
   * node ids — so a name-matched change names the endpoints it affects only if
   * the key matches the graph's byte for byte. Diverge and every one of them
   * lands in `unattributed` with no affected APIs at all.
   */
  it('attributes a name-matched field change to real endpoints', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('email', { type: 'integer' })])]);

    const { impact } = compareSnapshots(before, after);

    expect(impact.unattributed).toEqual([]);
    expect(impact.incomplete).toBe(false);
    expect(impact.affected.length).toBeGreaterThan(0);
    expect(impact.artifacts.length).toBeGreaterThan(0);
  });

  it('still spares DELETE, which the precision rule exists for', () => {
    const before = legacy(1, [entity('User', [field('email'), field('age')])]);
    const after = legacy(2, [entity('User', [field('email'), field('age', { type: 'integer' })])]);

    const { impact } = compareSnapshots(before, after);
    const labels = impact.affected.map((endpoint) => `${endpoint.method} ${endpoint.path}`);

    // `DELETE /user/{id}` sends a path parameter and returns no body, so
    // changing `age` cannot reach it — through the name fallback as much as
    // through ids.
    expect(labels.some((label) => label.startsWith('DELETE'))).toBe(false);
    expect(impact.unaffected.some((endpoint) => endpoint.method === 'DELETE')).toBe(true);
  });
});

describe('compareSnapshots builds the graph from the `to` side', () => {
  it('treats an entity absent from `to` as removed, and attributes it', () => {
    const before = modern(3, [entity('User', [field('email')]), entity('Order', [field('total')])]);
    const after = modern(4, [entity('User', [field('email')])]);

    const { diff, impact } = compareSnapshots(before, after);

    expect(kinds(diff)).toEqual(['ENTITY_REMOVED']);
    // A removed entity has no node in the `to` graph, so it is attributed to the
    // discovery document rather than being dropped as unidentifiable.
    expect(impact.unattributed).toEqual([]);
    expect(impact.artifacts.length).toBeGreaterThan(0);
  });

  /**
   * `v4 → v2` is what rolling back to v2 does, so this makes the impact report
   * the rollback impact report for free — no direction special-case anywhere.
   */
  it('answers a backward pair as the rollback it describes', () => {
    const v4 = modern(4, [entity('User', [field('email')]), entity('Order', [field('total')])]);
    const v2 = modern(2, [entity('User', [field('email')])]);

    const { diff, impact } = compareSnapshots(v4, v2);

    expect(diff.direction).toBe('backward');
    // Rolling back loses `Order` — reported as a removal, not an addition.
    expect(kinds(diff)).toEqual(['ENTITY_REMOVED']);
    // `unaffected` is measured against v2's endpoint set, which is the one that
    // would exist afterwards.
    expect(impact.unaffected.every((endpoint) => !endpoint.path.includes('order'))).toBe(true);
  });
});

describe('history is never mutated', () => {
  it('leaves both inputs byte-identical', () => {
    // §47 forbids mutating historical versions, and `ensureSchemaIds` — which
    // `materializeRelations` sits next to — mutates in place. The clone is what
    // makes a stray write impossible rather than merely unlikely.
    const before = modern(3, [entity('User', [field('email')])]);
    const after = modern(4, [entity('User', [field('email', { type: 'integer' })])]);

    const beforeJson = JSON.stringify(before.ips);
    const afterJson = JSON.stringify(after.ips);

    compareSnapshots(before, after);

    expect(JSON.stringify(before.ips)).toBe(beforeJson);
    expect(JSON.stringify(after.ips)).toBe(afterJson);
  });

  it('mints no ids, so an id-less snapshot stays id-less', () => {
    const before = legacy(1, [entity('User', [field('email')])]);
    const after = legacy(2, [entity('User', [field('email', { type: 'integer' })])]);

    compareSnapshots(before, after);

    // Minting here would make the two sides unmatchable and turn every element
    // into a removal plus an addition.
    expect(before.ips.entities[0]!.id).toBeUndefined();
    expect(after.ips.entities[0]!.fields[0]!.id).toBeUndefined();
  });
});

describe('mixed identification', () => {
  it('reports byId and byName side by side, and names only the affected entity', () => {
    // One entity carries ids, the other does not — so the badge belongs on the
    // group that earned it rather than over the whole page.
    const before = modern(3, [entity('User', [field('email')])]);
    const withLegacyEntity = clone(before.ips);
    withLegacyEntity.entities.push(entity('Order', [field('total')]));

    const after: SchemaSnapshot = {
      version: 4,
      ips: (() => {
        const next = clone(withLegacyEntity);
        next.entities[1]!.fields[0]!.type = 'decimal';
        return next;
      })(),
      config: before.config,
    };

    const { matching } = diffSnapshots({ ...before, ips: withLegacyEntity }, after);

    expect(matching.byName).toBeGreaterThan(0);
    expect(matching.legacyBothSides).toBe(false);
    expect(matching.nameMatchedEntities).toEqual(['Order']);
  });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

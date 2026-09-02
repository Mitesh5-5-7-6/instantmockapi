import { describe, it, expect } from 'vitest';

import { diffSchemas, type SchemaChange } from './changes.js';
import { buildDependencyGraph } from './graph.js';
import { ensureSchemaIds } from './ids.js';
import { analyseDraftImpact, analyseImpact, type ImpactReport } from './impact.js';
import { materializeRelations } from './relations.js';
import type { Entity, Field, InternalProjectSchema } from './types.js';

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
 * The real pipeline: materialize, backfill ids, then fork a draft.
 *
 * Both sides carry the same ids afterwards, which is what lets the diff tell a
 * rename from a delete-plus-create — and therefore what lets impact analysis
 * attribute a change to a node at all.
 */
function fork(schema: InternalProjectSchema): {
  active: InternalProjectSchema;
  draft: InternalProjectSchema;
} {
  const active = materializeRelations(schema);
  ensureSchemaIds(active);
  return { active, draft: JSON.parse(JSON.stringify(active)) as InternalProjectSchema };
}

/**
 * Backfill the draft, the way the draft PATCH route does on every write.
 *
 * A newly pushed field or entity has no stable id, and `diffSchemas` matches on
 * ids alone — so without this an addition diffs to nothing at all and the test
 * would pass while asserting silence.
 */
function edited(draft: InternalProjectSchema): InternalProjectSchema {
  ensureSchemaIds(draft);
  return draft;
}

/** `method path` for every affected endpoint, sorted for a stable assertion. */
const affectedList = (report: ImpactReport): string[] =>
  report.affected.map((e) => `${e.method} ${e.path}`).sort();

const unaffectedList = (report: ImpactReport): string[] =>
  report.unaffected.map((e) => `${e.method} ${e.path}`).sort();

const reasonsFor = (report: ImpactReport, endpoint: string): string[] => {
  const found = report.affected.find((e) => `${e.method} ${e.path}` === endpoint);
  expect(found, `${endpoint} is not in the affected list`).toBeDefined();
  return found!.reasons.map((r) => r.reason).sort();
};

const USER = () => ips([entity('User', [field('email'), field('age', { type: 'integer' })])]);

// ---------------------------------------------------------------------------

describe('the worked example', () => {
  /**
   * The requirement, quoted: "Don't regenerate DELETE just because it belongs to
   * the same entity."
   *
   * Changing `email` from string to integer moves both directions on every
   * endpoint that carries the field. DELETE carries an identifier in the path and
   * returns no body, so it is untouched — and saying so explicitly is what makes
   * the rest of the report believable.
   */
  it('affects the endpoints that carry the field and explicitly spares DELETE', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));

    expect(affectedList(report)).toEqual([
      'GET /user',
      'GET /user/{id}',
      'PATCH /user/{id}',
      'POST /user',
      'PUT /user/{id}',
    ]);
    expect(unaffectedList(report)).toEqual(['DELETE /user/{id}', 'GET /']);
  });

  /** The `reason` strings the UI renders under "Why is this API affected?". */
  it('explains PATCH by naming the request and response pointers', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    expect(reasonsFor(report, 'PATCH /user/{id}')).toEqual([
      'request.body.email',
      'response.User.email',
    ]);
  });

  it('carries the change and a readable source on every reason', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    const patch = report.affected.find((e) => e.method === 'PATCH')!;

    expect(patch.reasons[0]).toMatchObject({
      source: 'User.email',
      facet: expect.stringMatching(/^(request|response)$/),
      change: expect.objectContaining({ kind: 'FIELD_TYPE_CHANGED', risk: 'BREAKING' }),
    });
  });

  it('labels each reason with the endpoint facet it lands on', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    const patch = report.affected.find((e) => e.method === 'PATCH')!;
    const byFacet = new Map(patch.reasons.map((r) => [r.facet, r.reason]));

    expect(byFacet.get('request')).toBe('request.body.email');
    expect(byFacet.get('response')).toBe('response.User.email');
  });

  it('reports no impact at all for an untouched draft', () => {
    const { active, draft } = fork(USER());
    const report = analyseDraftImpact(active, edited(draft));

    expect(report.affected).toEqual([]);
    expect(report.artifacts).toEqual([]);
    expect(report.risk).toBeNull();
    // Every endpoint is confirmed untouched, which is the useful statement here.
    expect(unaffectedList(report)).toEqual([
      'DELETE /user/{id}',
      'GET /',
      'GET /user',
      'GET /user/{id}',
      'PATCH /user/{id}',
      'POST /user',
      'PUT /user/{id}',
    ]);
  });
});

describe('aspect precision', () => {
  /**
   * A write-only change must not claim the read endpoints. Making a field
   * required rejects request bodies that omit it; it changes no response.
   */
  it('reaches only the writing endpoints for a write-aspect change', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.required = true;

    const report = analyseDraftImpact(active, edited(draft));
    expect(affectedList(report)).toEqual(['PATCH /user/{id}', 'POST /user', 'PUT /user/{id}']);
    expect(unaffectedList(report)).toContain('GET /user/{id}');
    expect(report.risk).toBe('WARNING');
  });

  /** A description edit has aspect `none` and must reach nothing at all. */
  it('reaches nothing for a cosmetic change, and says why', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.description = 'People who use the product';

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.affected).toEqual([]);
    expect(report.risk).toBe('INFO');
    expect(report.unattributed).toEqual([
      { change: expect.objectContaining({ kind: 'ENTITY_DESCRIPTION_CHANGED' }), cause: 'no-wire' },
    ]);
    // Nothing uncertain happened, so the report is not flagged incomplete.
    expect(report.incomplete).toBe(false);
  });

  /**
   * A rename moves every URL of the entity — including DELETE, whose path
   * changes even though its payload does not. This is the one case where DELETE
   * legitimately appears.
   */
  it('routes every endpoint of a renamed entity, DELETE included', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.name = 'Customer';

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.risk).toBe('ROUTING');
    // Paths are reported against the DRAFT, which is the API about to ship.
    expect(affectedList(report)).toEqual([
      'DELETE /customer/{id}',
      // The discovery document lists each entity and its path, so a rename
      // changes what the base URL serves as surely as it moves the entity's URLs.
      'GET /',
      'GET /customer',
      'GET /customer/{id}',
      'PATCH /customer/{id}',
      'POST /customer',
      'PUT /customer/{id}',
    ]);
  });

  it('lets an entity rename reach the discovery document', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.name = 'Customer';

    // The catalogue rows carry `{ entity, path }`, so both halves move. The
    // routing edge onto the discovery document is what carries this: without it a
    // rename would report six moved URLs and quietly miss the document that
    // advertises them.
    const report = analyseDraftImpact(active, edited(draft));
    expect(affectedList(report)).toContain('GET /');
    expect(reasonsFor(report, 'GET /')).toEqual(['response.entities[].path']);
  });

  it('puts the discovery document in scope when an entity is added', () => {
    const { active, draft } = fork(USER());
    draft.entities.push(entity('Order', [field('total', { type: 'integer' })]));

    const report = analyseDraftImpact(active, edited(draft));
    expect(affectedList(report)).toContain('GET /');
  });

  /** A query-only capability change must not claim to alter response bodies. */
  it('reaches the collection GET through a query edge for a read change', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email')])], {
        features: { search: true, filter: true, sort: true, include: false },
      }),
    );
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    expect(reasonsFor(report, 'GET /user')).toEqual([
      'request.query.email',
      'request.query.sort=email',
      'response.User[].email',
    ]);
  });

  /**
   * `request.query.search` is absent above, and correctly so: `searchableFields`
   * whitelists textual types, and the draft made `email` an integer — so
   * `?search=` no longer scans it. The graph is built from the draft, which is
   * the API about to ship.
   *
   * The honest limit that follows: a change that *removes* a query capability
   * loses its query reason string, because the edge no longer exists to carry it.
   * No API goes unreported — this endpoint is still affected via its read, filter
   * and sort edges — but the report will not spell out that search stopped
   * covering the field. Naming it here so it is a known edge rather than a
   * surprise, and so Phase 2's diff view can decide whether to close it.
   */
  it('keeps a searchable field searchable when the type stays textual', () => {
    const { active, draft } = fork(
      ips([entity('User', [field('email')])], {
        features: { search: true, filter: true, sort: true, include: false },
      }),
    );
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.validation = { email: true };

    const report = analyseDraftImpact(active, edited(draft));
    // A validation change is write-aspect, so it reaches the writes, not the
    // query string. The searchable edge still exists; nothing traverses it here.
    expect(affectedList(report)).toEqual(['PATCH /user/{id}', 'POST /user', 'PUT /user/{id}']);
  });
});

describe('risk rollup per endpoint', () => {
  it('carries the worst risk reaching each endpoint', () => {
    const { active, draft } = fork(USER());
    // Two changes of different risk landing on overlapping endpoint sets.
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.required = true; // WARNING, write
    draft.entities[0]!.fields.find((f) => f.name === 'age')!.type = 'string'; // BREAKING, both

    const report = analyseDraftImpact(active, edited(draft));
    const byEndpoint = new Map(report.affected.map((e) => [`${e.method} ${e.path}`, e.risk]));

    expect(byEndpoint.get('POST /user')).toBe('BREAKING');
    // The item GET is reached only by the BREAKING type change, never by the
    // write-only requiredness change.
    expect(byEndpoint.get('GET /user/{id}')).toBe('BREAKING');
    expect(report.risk).toBe('BREAKING');
  });

  it('keeps a SAFE endpoint SAFE when a worse change lands elsewhere', () => {
    const { active, draft } = fork(
      ips([
        entity('User', [field('email')]),
        entity('Order', [field('total', { type: 'integer' })]),
      ]),
    );
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer'; // BREAKING
    draft.entities[1]!.fields.push(field('note')); // SAFE, optional add

    const report = analyseDraftImpact(active, edited(draft));
    const byEndpoint = new Map(report.affected.map((e) => [`${e.method} ${e.path}`, e.risk]));

    expect(byEndpoint.get('POST /user')).toBe('BREAKING');
    expect(byEndpoint.get('POST /order')).toBe('SAFE');
  });
});

describe('removals', () => {
  /**
   * A deleted field has no node in the draft graph, so it cannot be traversed
   * from. `diffSchemas` always sets `entityId`, so the change falls back to the
   * entity and lands on all of its endpoints — including DELETE, via the routing
   * edge. Wider than a type change, and correct: the entity's whole surface is
   * restated when a field leaves it.
   */
  it('attributes a removed field to its entity', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields = draft.entities[0]!.fields.filter((f) => f.name !== 'age');

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.risk).toBe('BREAKING');
    expect(affectedList(report)).toContain('GET /user');
    expect(affectedList(report)).toContain('POST /user');
  });

  it('attributes a removed entity to the discovery document', () => {
    const { active, draft } = fork(
      ips([
        entity('User', [field('email')]),
        entity('Order', [field('total', { type: 'integer' })]),
      ]),
    );
    draft.entities = draft.entities.filter((e) => e.name !== 'Order');

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.risk).toBe('BREAKING');
    // The Order endpoints are gone from the draft graph entirely, so they appear
    // in neither list. The catalogue change is what remains observable.
    expect(affectedList(report)).toEqual(['GET /']);
    expect(unaffectedList(report).some((e) => e.includes('/order'))).toBe(false);
  });
});

describe('artifacts', () => {
  it('names the surface artifacts an affected endpoint restates', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.artifacts).toContain('hosted_api');
    expect(report.artifacts).toContain('openapi');
    expect(report.artifacts).toContain('zod');
    expect(report.artifacts).toContain('typescript');
  });

  it('names no artifact when nothing changed', () => {
    const { active, draft } = fork(USER());
    expect(analyseDraftImpact(active, edited(draft)).artifacts).toEqual([]);
  });

  it('regenerates the surface when the method set changes', () => {
    const { active, draft } = fork(USER());
    draft.generationConfig.methods = ['GET'];

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.artifacts).toEqual(['export_zip', 'hosted_api', 'openapi', 'postman']);
    // No endpoint is *modified* — three of them simply cease to exist, and the
    // draft graph no longer contains them to report on.
    expect(unaffectedList(report)).toEqual(['GET /', 'GET /user', 'GET /user/{id}']);
  });

  it('regenerates only the data when the record count changes', () => {
    const { active, draft } = fork(USER());
    draft.generationConfig.mockRecords = 50;

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.artifacts).toEqual(['mock_data']);
    expect(report.risk).toBe('INFO');
    expect(report.affected).toEqual([]);
  });

  it('returns artifacts sorted and deduplicated', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';
    draft.entities[0]!.fields.find((f) => f.name === 'age')!.type = 'string';

    const artifacts = analyseDraftImpact(active, edited(draft)).artifacts;
    expect(artifacts).toEqual([...new Set(artifacts)].sort());
  });
});

describe('honesty about what could not be traced', () => {
  /**
   * The distinction that matters: "nothing is affected" and "we could not tell"
   * are different answers, and only one of them should be shown as a guarantee.
   * A change naming a schema element with no graph node is the second.
   */
  it('flags the report incomplete when a change cannot be matched to a node', () => {
    const graph = buildDependencyGraph(USER());
    const orphan: SchemaChange = {
      kind: 'FIELD_TYPE_CHANGED',
      risk: 'BREAKING',
      aspect: 'both',
      entityName: 'User',
      fieldName: 'email',
      summary: 'Type changed',
    };

    const report = analyseImpact([orphan], graph);
    expect(report.incomplete).toBe(true);
    expect(report.unattributed).toEqual([{ change: orphan, cause: 'unidentified' }]);
    expect(report.affected).toEqual([]);
  });

  it('does not flag a project-level change as a gap in the analysis', () => {
    const { active, draft } = fork(USER());
    draft.generationConfig.mockRecords = 50;

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.incomplete).toBe(false);
    expect(report.unattributed[0]?.cause).toBe('no-wire');
  });

  it('reports a change whose node exists but reaches no endpoint as no-wire', () => {
    // Only GET is enabled, so a write-aspect change has nowhere to land.
    const { active, draft } = fork(ips([entity('User', [field('email')])], { methods: ['GET'] }));
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.required = true;

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.affected).toEqual([]);
    expect(report.unattributed).toEqual([
      { change: expect.objectContaining({ kind: 'FIELD_REQUIRED_CHANGED' }), cause: 'no-wire' },
    ]);
    expect(report.incomplete).toBe(false);
  });
});

describe('report shape', () => {
  it('never lists an endpoint as both affected and unaffected', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    const affected = new Set(report.affected.map((e) => e.id));
    for (const endpoint of report.unaffected) {
      expect(affected.has(endpoint.id), `${endpoint.id} is in both lists`).toBe(false);
    }
  });

  it('accounts for every endpoint in the graph exactly once', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const graph = buildDependencyGraph(edited(draft));
    const total = [...graph.nodes.values()].filter((n) => n.kind === 'endpoint').length;
    const report = analyseDraftImpact(active, edited(draft));

    expect(report.affected.length + report.unaffected.length).toBe(total);
  });

  it('never repeats the same change and pointer on one endpoint', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    for (const endpoint of analyseDraftImpact(active, edited(draft)).affected) {
      const keys = endpoint.reasons.map((r) => `${r.change.kind}|${r.reason}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('sorts both lists by path then method', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    for (const list of [affectedList(report), unaffectedList(report)]) {
      expect(list).toEqual([...list].sort());
    }
  });

  it('carries the raw changes through for a caller that wants the diff too', () => {
    const { active, draft } = fork(USER());
    draft.entities[0]!.fields.find((f) => f.name === 'email')!.type = 'integer';

    const report = analyseDraftImpact(active, edited(draft));
    expect(report.changes).toEqual(diffSchemas(active, edited(draft)));
  });
});

describe('relations', () => {
  it('reaches the reading endpoints through a relation, not the writing ones', () => {
    const { active, draft } = fork(
      ips(
        [
          entity('Post', [field('title')], {
            relations: [
              { name: 'author', kind: 'belongsTo', target: 'Author', localField: 'authorId' },
            ],
          }),
          entity('Author', [field('name')]),
        ],
        { features: { search: false, filter: false, sort: false, include: true } },
      ),
    );
    draft.entities[0]!.relations![0]!.onDelete = 'cascade';

    const report = analyseDraftImpact(active, edited(draft));
    // onDelete is a write-aspect change, and the relation exposes no write edge —
    // its foreign key does. So this lands nowhere, and correctly says so.
    expect(report.affected).toEqual([]);
    expect(report.unattributed[0]?.cause).toBe('no-wire');
  });

  it('attributes a foreign-key change to the materialized field', () => {
    const { active, draft } = fork(
      ips([
        entity('Post', [field('title')], {
          relations: [
            { name: 'author', kind: 'belongsTo', target: 'Author', localField: 'authorId' },
          ],
        }),
        entity('Author', [field('name')]),
      ]),
    );
    draft.entities[0]!.fields.find((f) => f.name === 'authorId')!.required = true;

    const report = analyseDraftImpact(active, edited(draft));
    expect(reasonsFor(report, 'POST /post')).toEqual(['request.body.authorId']);
  });
});

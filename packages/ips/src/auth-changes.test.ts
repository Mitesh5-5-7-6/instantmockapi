import { describe, it, expect } from 'vitest';

import { authDirection, diffSchemas, type SchemaChange } from './changes.js';
import { groupChanges } from './grouping.js';
import { classifyImpact } from './classification.js';
import { analyseDraftImpact } from './impact.js';
import { NO_AUTH } from './auth.js';
import type { AuthConfig, AuthMode, Entity, InternalProjectSchema } from './types.js';

/**
 * Phase 3 §17: authentication changes in the diff, and §18: only what they
 * actually affect regenerating.
 */

const entity = (name: string, id: string, authentication?: 'PUBLIC' | 'PROTECTED'): Entity => ({
  id,
  name,
  fields: [
    { id: `${id}_f1`, name: 'id', type: 'uuid', required: true },
    { id: `${id}_f2`, name: 'label', type: 'string', required: false },
  ],
  ...(authentication === undefined ? {} : { authentication }),
});

const auth = (mode: AuthMode, over: Partial<AuthConfig> = {}): AuthConfig => ({
  ...NO_AUTH,
  mode,
  signup: mode !== 'NONE',
  signin: mode !== 'NONE',
  refreshToken: mode !== 'NONE',
  ...over,
});

function ips(over: Partial<InternalProjectSchema> = {}): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities: [entity('Product', 'ent_prod'), entity('Payment', 'ent_pay')],
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 5,
    },
    ...over,
  };
}

/** Every change of one kind, so a test names the kind rather than an index. */
const of = (changes: SchemaChange[], kind: string) => changes.filter((c) => c.kind === kind);
const one = (changes: SchemaChange[], kind: string): SchemaChange => {
  const found = of(changes, kind);
  expect(found, `expected exactly one ${kind}`).toHaveLength(1);
  return found[0]!;
};

describe('authDirection', () => {
  /**
   * The asymmetry the whole family rests on. Requiring a token where none was
   * required breaks every caller at once; dropping the requirement breaks
   * nobody, because an unnecessary Authorization header is ignored.
   */
  it('calls adding protection tightened and removing it relaxed', () => {
    expect(authDirection('PUBLIC', 'PROTECTED')).toBe('tightened');
    expect(authDirection('PROTECTED', 'PUBLIC')).toBe('relaxed');
    expect(authDirection('PUBLIC', 'PUBLIC')).toBe('unchanged');
  });
});

describe('AUTH_MODE_CHANGED', () => {
  it('is breaking when the project becomes protected', () => {
    const changes = diffSchemas(
      ips({ authentication: auth('ALL_PUBLIC') }),
      ips({ authentication: auth('ALL_PROTECTED') }),
    );
    const change = one(changes, 'AUTH_MODE_CHANGED');
    expect(change.risk).toBe('BREAKING');
    expect(classifyImpact(change)).toBe('BREAKING');
  });

  it('is safe when protection is dropped', () => {
    // Nothing that worked stops working. Calling this breaking would train
    // people to ignore the label.
    const change = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({ authentication: auth('ALL_PUBLIC') }),
      ),
      'AUTH_MODE_CHANGED',
    );
    expect(change.risk).toBe('SAFE');
    expect(classifyImpact(change)).toBe('NON_BREAKING');
  });

  /**
   * The direction comes from what the endpoints require, not from the mode
   * names. Turning authentication *on* in ALL_PUBLIC mode adds an Auth API and
   * protects nothing — reporting a breaking change there would be a breaking
   * change that breaks nobody.
   */
  it('is not breaking when enabling auth leaves every endpoint public', () => {
    const change = one(
      diffSchemas(ips(), ips({ authentication: auth('ALL_PUBLIC') })),
      'AUTH_MODE_CHANGED',
    );
    expect(change.risk).not.toBe('BREAKING');
  });

  it('is breaking when a legacy project goes straight to protected', () => {
    // §26's project has no authentication block at all, so this is the
    // NONE → ALL_PROTECTED path.
    const change = one(
      diffSchemas(ips(), ips({ authentication: auth('ALL_PROTECTED') })),
      'AUTH_MODE_CHANGED',
    );
    expect(change.risk).toBe('BREAKING');
  });

  /**
   * §37 forbids a wall of rows. ALL_PUBLIC → ALL_PROTECTED on a twelve-entity
   * project is one decision, and the per-entity rows would be its echo — the
   * same problem the relation cascade solved by attributing to the cause.
   */
  it('does not also emit a row per entity', () => {
    const changes = diffSchemas(
      ips({ authentication: auth('ALL_PUBLIC') }),
      ips({ authentication: auth('ALL_PROTECTED') }),
    );
    expect(of(changes, 'ENTITY_AUTH_CHANGED')).toEqual([]);
  });
});

describe('ENTITY_AUTH_CHANGED', () => {
  const combination = (product: 'PUBLIC' | 'PROTECTED', payment: 'PUBLIC' | 'PROTECTED') =>
    ips({
      entities: [entity('Product', 'ent_prod', product), entity('Payment', 'ent_pay', payment)],
      authentication: auth('COMBINATION'),
    });

  it('reports the §17 example as breaking, against the entity', () => {
    const change = one(
      diffSchemas(combination('PUBLIC', 'PUBLIC'), combination('PUBLIC', 'PROTECTED')),
      'ENTITY_AUTH_CHANGED',
    );
    expect(change.risk).toBe('BREAKING');
    expect(change.entityName).toBe('Payment');
    expect(change.entityId).toBe('ent_pay');
    expect(change.summary).toContain('Payment');
    expect(change.before).toBe('PUBLIC');
    expect(change.after).toBe('PROTECTED');
  });

  it('says nothing about the entity that did not move', () => {
    const changes = diffSchemas(
      combination('PUBLIC', 'PUBLIC'),
      combination('PUBLIC', 'PROTECTED'),
    );
    expect(of(changes, 'ENTITY_AUTH_CHANGED').map((c) => c.entityName)).toEqual(['Payment']);
  });

  it('reports opening an entity as safe rather than breaking', () => {
    const change = one(
      diffSchemas(combination('PUBLIC', 'PROTECTED'), combination('PUBLIC', 'PUBLIC')),
      'ENTITY_AUTH_CHANGED',
    );
    expect(change.risk).toBe('SAFE');
  });

  /**
   * A stale stamp under a whole-project mode must not read as a change. The
   * entity field is only consulted in COMBINATION, so the *effective*
   * protection is what gets compared — otherwise every entity that had ever
   * been in combination mode would report a phantom auth change.
   */
  it('ignores a stale entity stamp that the mode overrides', () => {
    const changes = diffSchemas(
      ips({
        entities: [entity('Product', 'ent_prod', 'PUBLIC'), entity('Payment', 'ent_pay', 'PUBLIC')],
        authentication: auth('ALL_PROTECTED'),
      }),
      ips({
        entities: [
          entity('Product', 'ent_prod', 'PROTECTED'),
          entity('Payment', 'ent_pay', 'PROTECTED'),
        ],
        authentication: auth('ALL_PROTECTED'),
      }),
    );
    expect(of(changes, 'ENTITY_AUTH_CHANGED')).toEqual([]);
  });
});

describe('the rest of the auth surface', () => {
  it('reports removing an auth endpoint as breaking, adding one as safe', () => {
    const removed = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({ authentication: auth('ALL_PROTECTED', { refreshToken: false }) }),
      ),
      'AUTH_ENDPOINTS_CHANGED',
    );
    expect(removed.risk).toBe('BREAKING');
    expect(removed.summary).toContain('refresh');

    const added = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED', { signup: false }) }),
        ips({ authentication: auth('ALL_PROTECTED') }),
      ),
      'AUTH_ENDPOINTS_CHANGED',
    );
    expect(added.risk).toBe('SAFE');
  });

  it('reports a cookie-mode change as breaking in both directions', () => {
    // Enabling it stops returning tokens in the body; disabling it leaves a
    // browser client holding no credential at all.
    const on = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({ authentication: auth('ALL_PROTECTED', { cookieAuth: true }) }),
      ),
      'AUTH_COOKIE_CHANGED',
    );
    const off = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED', { cookieAuth: true }) }),
        ips({ authentication: auth('ALL_PROTECTED') }),
      ),
      'AUTH_COOKIE_CHANGED',
    );
    expect([on.risk, off.risk]).toEqual(['BREAKING', 'BREAKING']);
    expect([classifyImpact(on), classifyImpact(off)]).toEqual(['BREAKING', 'BREAKING']);
  });

  /**
   * §17 requires an expiry change in the history. It still breaks nobody — a
   * caller that refreshes on 401 cannot tell — so it must not be reported as
   * though it did.
   */
  it('records a token-lifetime change without calling it breaking', () => {
    const change = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({ authentication: auth('ALL_PROTECTED', { accessTokenExpiresIn: '1h' }) }),
      ),
      'AUTH_TOKEN_EXPIRY_CHANGED',
    );
    expect(change.risk).toBe('INFO');
    expect(classifyImpact(change)).toBe('NON_BREAKING');
    expect(change.aspect).toBe('none');
  });

  it('reports a new required signup field as breaking and a new optional one as safe', () => {
    const required = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({
          authentication: auth('ALL_PROTECTED', {
            userFields: [{ name: 'name', type: 'string', required: true }],
          }),
        }),
      ),
      'AUTH_USER_FIELDS_CHANGED',
    );
    expect(required.risk).toBe('BREAKING');
    expect(required.summary).toContain('name');

    const optional = one(
      diffSchemas(
        ips({ authentication: auth('ALL_PROTECTED') }),
        ips({
          authentication: auth('ALL_PROTECTED', {
            userFields: [{ name: 'nickname', type: 'string', required: false }],
          }),
        }),
      ),
      'AUTH_USER_FIELDS_CHANGED',
    );
    expect(optional.risk).toBe('SAFE');
  });

  it('reports nothing at all when the configuration is untouched', () => {
    const same = ips({ authentication: auth('COMBINATION') });
    const changes = diffSchemas(same, structuredClone(same));
    expect(
      changes.filter((c) => c.kind.startsWith('AUTH_') || c.kind === 'ENTITY_AUTH_CHANGED'),
    ).toEqual([]);
  });

  it('says nothing about auth for a project that never had any', () => {
    // §26. Two legacy documents must diff to nothing, not to a mode change
    // from undefined.
    expect(diffSchemas(ips(), ips())).toEqual([]);
  });
});

describe('§18: what an auth change regenerates', () => {
  const combination = (payment: 'PUBLIC' | 'PROTECTED') =>
    ips({
      entities: [entity('Product', 'ent_prod', 'PUBLIC'), entity('Payment', 'ent_pay', payment)],
      authentication: auth('COMBINATION'),
    });

  /**
   * The trap this test exists for.
   *
   * `aspect: 'both'` resolves to the read/write entity→endpoint edges, and
   * `graph.ts` excludes DELETE from those deliberately. Under `both`, protecting
   * Payment would report GET, POST, PUT and PATCH and silently omit
   * `DELETE /payment/{id}` — the one endpoint whose exposure matters most.
   * `routing` is emitted for every row.
   */
  it('includes DELETE among the affected endpoints', () => {
    const report = analyseDraftImpact(combination('PUBLIC'), combination('PROTECTED'));
    const methods = report.affected
      .filter((endpoint) => endpoint.path.includes('payment'))
      .map((endpoint) => endpoint.method);
    expect(methods).toContain('DELETE');
    expect(methods).toContain('GET');
  });

  it('leaves the unrelated entity alone', () => {
    const report = analyseDraftImpact(combination('PUBLIC'), combination('PROTECTED'));
    expect(report.affected.every((endpoint) => !endpoint.path.includes('product'))).toBe(true);
  });

  it('regenerates the surface artifacts and not the shape ones', () => {
    // §18's list: middleware, OpenAPI, Postman, docs, hosted API. No validators,
    // no types — an auth change moves no entity shape.
    const report = analyseDraftImpact(combination('PUBLIC'), combination('PROTECTED'));
    expect(report.artifacts).toContain('hosted_api');
    expect(report.artifacts).toContain('openapi');
    expect(report.artifacts).toContain('postman');
    expect(report.artifacts).not.toContain('zod');
    expect(report.artifacts).not.toContain('typescript');
  });

  /**
   * §22's users live in their own collection precisely so regenerating fixtures
   * cannot delete accounts — so an auth change has no business reseeding.
   */
  it('never reseeds mock data', () => {
    const report = analyseDraftImpact(combination('PUBLIC'), combination('PROTECTED'));
    expect(report.artifacts).not.toContain('mock_data');
  });

  it('rebuilds only the runtime for a token-lifetime change', () => {
    const report = analyseDraftImpact(
      ips({ authentication: auth('ALL_PROTECTED') }),
      ips({ authentication: auth('ALL_PROTECTED', { refreshTokenExpiresIn: '30d' }) }),
    );
    expect(report.artifacts).toEqual(['hosted_api']);
  });

  it('rebuilds the docs when the Auth API gains or loses an endpoint', () => {
    const report = analyseDraftImpact(
      ips({ authentication: auth('ALL_PROTECTED', { signup: false }) }),
      ips({ authentication: auth('ALL_PROTECTED') }),
    );
    expect(report.artifacts).toContain('openapi');
    expect(report.artifacts).toContain('hosted_api');
  });

  /**
   * A project-level auth change names no entity, because the Auth API is not
   * one. It must still be *attributed* — landing in `unattributed` as
   * `unidentified` would set the report's `incomplete` flag and make the whole
   * page caveat itself.
   */
  it('does not mark the report incomplete', () => {
    const report = analyseDraftImpact(
      ips({ authentication: auth('ALL_PROTECTED') }),
      ips({ authentication: auth('ALL_PROTECTED', { cookieAuth: true }) }),
    );
    expect(report.unattributed.every((entry) => entry.cause !== 'unidentified')).toBe(true);
  });
});

describe('§37: where an auth change appears in the grouped tree', () => {
  const combination = (payment: 'PUBLIC' | 'PROTECTED') =>
    ips({
      entities: [entity('Product', 'ent_prod', 'PUBLIC'), entity('Payment', 'ent_pay', payment)],
      authentication: auth('COMBINATION'),
    });

  /**
   * A per-entity change nests under its entity, so the compare page shows it
   * beside that entity's field changes rather than in a project-level bucket.
   */
  it('nests ENTITY_AUTH_CHANGED under its entity', () => {
    const changes = diffSchemas(combination('PUBLIC'), combination('PROTECTED'));
    const tree = groupChanges(changes);

    const payment = tree.entities.find((group) => group.name === 'Payment');
    expect(payment).toBeDefined();
    expect(payment!.own.some((entry) => entry.change.kind === 'ENTITY_AUTH_CHANGED')).toBe(true);
    expect(tree.project.changes.some((entry) => entry.change.kind === 'ENTITY_AUTH_CHANGED')).toBe(
      false,
    );
  });

  /**
   * A mode change genuinely has no entity — it is one decision about the whole
   * project — so it belongs in the project group even though its *impact* fans
   * out across every entity it moved.
   */
  it('puts AUTH_MODE_CHANGED in the project group', () => {
    const changes = diffSchemas(
      ips({ authentication: auth('ALL_PUBLIC') }),
      ips({ authentication: auth('ALL_PROTECTED') }),
    );
    const tree = groupChanges(changes);

    expect(tree.project.changes.some((entry) => entry.change.kind === 'AUTH_MODE_CHANGED')).toBe(
      true,
    );
    // And it is not duplicated into the entities it reached.
    expect(
      tree.entities.some((group) =>
        group.own.some((entry) => entry.change.kind === 'AUTH_MODE_CHANGED'),
      ),
    ).toBe(false);
  });

  it('groups the Auth API settings at project level too', () => {
    const changes = diffSchemas(
      ips({ authentication: auth('ALL_PROTECTED') }),
      ips({ authentication: auth('ALL_PROTECTED', { cookieAuth: true }) }),
    );
    const tree = groupChanges(changes);
    expect(tree.project.changes.some((entry) => entry.change.kind === 'AUTH_COOKIE_CHANGED')).toBe(
      true,
    );
  });
});

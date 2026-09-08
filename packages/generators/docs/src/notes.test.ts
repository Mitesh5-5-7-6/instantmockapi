import { describe, it, expect } from 'vitest';
import {
  ensureSchemaIds,
  materializeRelations,
  type AuthConfig,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { goldenRelationsIPS } from '../../../ips/__tests__/golden-relations-fixture.js';
import { buildDocumentationModel, flattenFields } from './notes-model.js';
import { renderTechnicalNotes } from './notes-markdown.js';

/**
 * Technical Notes (Phase 4 §25, §26).
 *
 * Three claims run through all of it:
 *
 * - **Complete.** Every entity, field, relation and endpoint of the actual
 *   project appears. §3 is explicit that the document must use real project
 *   data, so these assertions read the fixture rather than hardcoding names.
 * - **Deterministic.** Same definition in, byte-identical document out.
 * - **No secrets.** §26 wants this proven rather than assumed, so the check is a
 *   search of the rendered output for every forbidden term.
 */

const authConfig = (mode: AuthConfig['mode'], over: Partial<AuthConfig> = {}): AuthConfig => ({
  mode,
  signup: true,
  signin: true,
  refreshToken: true,
  cookieAuth: false,
  accessTokenExpiresIn: '15m',
  refreshTokenExpiresIn: '7d',
  userFields: [],
  ...over,
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The relations fixture, materialized — the shape the API actually stores. */
function relationalIps(auth?: AuthConfig): InternalProjectSchema {
  const ips = materializeRelations(clone(goldenRelationsIPS));
  return auth === undefined ? ips : { ...ips, authentication: auth };
}

function simpleIps(auth?: AuthConfig): InternalProjectSchema {
  const ips = materializeRelations(clone(goldenFixtureIPS));
  return auth === undefined ? ips : { ...ips, authentication: auth };
}

/**
 * The same definition with stable ids minted — a **live** project.
 *
 * The fixtures predate stable ids, which is itself a realistic state (a
 * historical `Version.ipsSnapshot` often carries none). A live project has had
 * `ensureSchemaIds` run on it by the create and draft paths, so both states
 * need covering and they are different assertions.
 */
function identifiedIps(auth?: AuthConfig): InternalProjectSchema {
  const ips = relationalIps(auth);
  ensureSchemaIds(ips);
  return ips;
}

const model = (ips: InternalProjectSchema, name = 'Shop') =>
  buildDocumentationModel(ips, { name });

const render = (ips: InternalProjectSchema, name = 'Shop') => renderTechnicalNotes(model(ips, name));

describe('§3: every entity and field appears', () => {
  it('documents every entity in the definition', () => {
    const ips = relationalIps();
    const notes = render(ips);
    for (const entity of ips.entities) {
      expect(notes, entity.name).toContain(entity.name);
    }
  });

  it('documents every field, nested ones included', () => {
    const ips = relationalIps();
    const notes = render(ips);
    const built = model(ips);

    for (const entity of built.entities) {
      for (const field of flattenFields(entity.fields)) {
        expect(notes, `${entity.name}.${field.path}`).toContain(field.name);
      }
    }
  });

  it('documents each field’s stable id, type and requiredness', () => {
    const ips = identifiedIps();
    const built = model(ips);
    const notes = render(ips);
    const identified = flattenFields(built.entities[0]!.fields).find(
      (field) => field.id !== null,
    );

    expect(identified, 'fixture carries no field ids at all').toBeDefined();
    expect(notes).toContain(identified!.id!);
    expect(notes).toContain(identified!.type);
    expect(notes).toMatch(/required|optional/);
  });

  /**
   * A synthesized field has no stable id, and the document says so rather than
   * inventing one.
   *
   * `materializeRelations` adds the identity field and every foreign key;
   * `ensureSchemaIds` is what mints ids, and it runs on the draft path. So a
   * materialized-but-not-backfilled definition legitimately carries fields with
   * no id — which is the state a historical `Version.ipsSnapshot` is often in.
   */
  it('reports a synthesized field’s missing id honestly', () => {
    const built = model(relationalIps());
    const identity = flattenFields(built.entities[0]!.fields).find(
      (field) => field.traits.includes('identity'),
    );

    expect(identity, 'materializeRelations should add an identity field').toBeDefined();
    expect(identity!.id).toBeNull();
    expect(render(relationalIps())).toContain('(none — predates stable ids)');
  });

  it('documents validation rules as their actual values', () => {
    // §3's own example: `validation: min=18`. Placeholders would defeat the
    // document's purpose.
    const ips = simpleIps();
    const target = ips.entities[0]!.fields.find((field) => (field.children?.length ?? 0) > 0);
    const leaf = target?.children.find((child) => child.name === 'age') ?? target?.children[0];
    if (leaf === undefined) {
      throw new Error('fixture shape changed');
    }
    leaf.validation = { ...leaf.validation, min: 18, max: 120 };

    const notes = render(ips);
    expect(notes).toContain('min=18');
    expect(notes).toContain('max=120');
  });

  /**
   * `null` means *no default* in this codebase — a convention, not a guess.
   *
   * `packages/generators/validation/src/zod.ts` and `yup.ts` both emit
   * `.default(...)` only when the stored value is neither `undefined` nor
   * `null`, and the parsers write `null` as their unset value. So the
   * generated validators — the things that actually apply a default at
   * runtime — treat the two identically, and a document that printed
   * `default null` would claim behaviour no generated code has. It would also
   * print it on nearly every field, since `materializeRelations` and the JSON
   * adapter set `null` throughout.
   *
   * The model keeps the raw value and answers the question separately, so the
   * renderers never have to re-derive this rule.
   */
  it('treats a null default as no default, matching the generated validators', () => {
    const ips = simpleIps();
    const built = buildDocumentationModel(ips, { name: 'Shop' });
    const fields = flattenFields(built.entities[0]!.fields);

    // The fixture carries both, unmodified — `id`/`slug`/`rating` are null,
    // `status`/`viewCount`/`published` have real defaults.
    const nulled = fields.filter((field) => field.default === null);
    expect(nulled.length).toBeGreaterThan(0);
    expect(nulled.every((field) => field.hasDefault)).toBe(false);

    const real = fields.find((field) => field.name === 'status');
    expect(real?.hasDefault).toBe(true);
    // The raw value survives — the model reports, it does not normalise.
    expect(real?.default).toBe('draft');

    const notes = render(ips);
    expect(notes).toContain('default "draft"');
    // The claim that would be false: never printed, for any of the null fields.
    expect(notes).not.toContain('default null');
    expect(notes).not.toContain('default —');
  });

  /**
   * `0`, `false` and `""` are defaults, and a truthiness test would lose them.
   *
   * Worth its own assertion because the wrong gate is the obvious one to write
   * and its failure is silent: the document would simply stop mentioning that
   * `viewCount` starts at zero, which is exactly the fact a consumer needs.
   */
  it('keeps a falsy default, which is still a default', () => {
    const ips = simpleIps();
    const notes = render(ips);

    expect(notes).toContain('default 0');
    expect(notes).toContain('default false');
    expect(notes).toContain('default ""');
  });

  it('names the identity field and its style', () => {
    const notes = render(relationalIps());
    expect(notes).toMatch(/Identity: `\w+` \((int|uuid)\)/);
  });
});

describe('§4: relationships', () => {
  it('documents every relation with its endpoints and cardinality', () => {
    const built = model(relationalIps());
    const notes = render(relationalIps());

    expect(built.relations.length).toBeGreaterThan(0);
    for (const relation of built.relations) {
      expect(notes, relation.name).toContain(relation.name);
      expect(notes, `${relation.source}.${relation.localField}`).toContain(
        `${relation.source}.${relation.localField}`,
      );
      expect(notes, relation.cardinality).toContain(relation.cardinality);
    }
  });

  it('states the cascade behaviour, which is not visible from the field list', () => {
    const notes = render(relationalIps());
    expect(notes).toMatch(/on delete (restrict|cascade|setNull)/);
  });

  it('says nothing about relationships when there are none', () => {
    // A "Relationships" heading over an empty list reads as missing data.
    const notes = render(simpleIps());
    const built = model(simpleIps());
    if (built.relations.length === 0) {
      expect(notes).not.toContain('## Relationships');
    }
  });

  /**
   * A historical snapshot is a `Mixed` document, so its relations are not
   * guaranteed to satisfy `RelationKind`.
   *
   * Phase 4 renders old versions (§20) and, later, imported blueprints (§14),
   * neither of which passed through today's validator. The failure this guards
   * is cosmetic but corrosive: a document containing the literal word
   * `undefined` reads as a broken renderer, so a reviewer stops trusting the
   * facts around it.
   */
  it('says unspecified rather than undefined for a relation with no kind', () => {
    const ips = relationalIps();
    const relation = ips.entities.flatMap((entity) => entity.relations)[0];
    if (relation === undefined) {
      throw new Error('fixture shape changed');
    }
    // Exactly what an old snapshot can hold, reached the way Mongo would.
    delete (relation as { kind?: unknown }).kind;

    const notes = render(ips);
    expect(notes).not.toContain('undefined');
    expect(notes).toContain('unspecified');
  });
});

describe('§5: the API surface', () => {
  it('documents every derived endpoint with its method and path', () => {
    const built = model(relationalIps());
    const notes = render(relationalIps());

    expect(built.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of built.endpoints) {
      expect(notes, `${endpoint.method} ${endpoint.path}`).toContain(
        `${endpoint.method} ${endpoint.path}`,
      );
    }
  });

  it('lists the path parameters a route declares', () => {
    const built = model(relationalIps());
    const item = built.endpoints.find((endpoint) => endpoint.pathParams.length > 0);
    expect(item).toBeDefined();
    expect(render(relationalIps())).toContain(`path: ${item!.pathParams.join(', ')}`);
  });

  it('lists only query parameters the runtime would accept', () => {
    const built = model(relationalIps());
    const list = built.endpoints.find(
      (endpoint) => endpoint.method === 'GET' && endpoint.queryParams.length > 0,
    );
    expect(list?.queryParams).toContain('page');
    expect(list?.queryParams).toContain('limit');
  });

  /**
   * §5's central requirement, and the reason the model resolves rather than
   * copies: the document must say what a caller has to *do*, not restate the
   * stored override.
   */
  it('states resolved authentication per endpoint, not the raw override', () => {
    const notes = render(relationalIps(authConfig('ALL_PROTECTED')));
    expect(notes).toContain('Authentication: Required');
    // The stored vocabulary must not leak into the per-endpoint lines.
    expect(notes).not.toContain('Entity authentication: PROTECTED');
  });

  it('resolves ALL_PROTECTED even where an entity is stamped public', () => {
    const ips = relationalIps(authConfig('ALL_PROTECTED'));
    ips.entities[0]!.authentication = 'PUBLIC';

    const built = buildDocumentationModel(ips, { name: 'Shop' });
    expect(built.entities.every((entity) => entity.requiresAuth)).toBe(true);
    expect(
      built.endpoints.filter((endpoint) => !endpoint.isAuthApi && endpoint.entity !== null).every(
        (endpoint) => endpoint.requiresAuth,
      ),
    ).toBe(true);
  });

  it('resolves COMBINATION per entity', () => {
    const ips = relationalIps(authConfig('COMBINATION'));
    ips.entities.forEach((entity, index) => {
      entity.authentication = index === 0 ? 'PROTECTED' : 'PUBLIC';
    });

    const built = buildDocumentationModel(ips, { name: 'Shop' });
    expect(built.entities[0]!.requiresAuth).toBe(true);
    expect(built.entities.slice(1).every((entity) => !entity.requiresAuth)).toBe(true);
  });

  /** The discovery document advertises routes and carries no record data. */
  it('never marks the discovery document as protected', () => {
    const built = model(relationalIps(authConfig('ALL_PROTECTED')));
    const index = built.endpoints.find((endpoint) => endpoint.path === '/');
    expect(index?.requiresAuth).toBe(false);
  });
});

describe('§6: authentication', () => {
  it('says Disabled plainly when there is none', () => {
    const notes = render(relationalIps());
    expect(notes).toContain('Authentication: Disabled');
  });

  /**
   * §6: "Do not generate misleading auth sections." An absent section reads as
   * "not documented"; a populated one on a project with no auth is worse still.
   */
  it('documents no endpoints or lifetimes when authentication is off', () => {
    const built = model(relationalIps());
    expect(built.auth.enabled).toBe(false);
    expect(built.auth.endpoints).toEqual([]);
    expect(built.auth.protectedEntities).toEqual([]);

    const notes = render(relationalIps());
    expect(notes).not.toContain('/signIn');
    expect(notes).not.toContain('Access token lifetime');
  });

  it('documents the configuration when it is on', () => {
    const notes = render(
      relationalIps(authConfig('ALL_PROTECTED', { cookieAuth: true, accessTokenExpiresIn: '5m' })),
    );
    expect(notes).toContain('Mode: ALL_PROTECTED');
    expect(notes).toContain('Access token lifetime: 5m');
    expect(notes).toContain('Cookie authentication: Yes');
    expect(notes).toContain('POST /signIn');
    expect(notes).toContain('GET /me');
  });

  it('omits an endpoint the project does not generate', () => {
    const notes = render(
      relationalIps(authConfig('ALL_PROTECTED', { signup: false, refreshToken: false })),
    );
    expect(notes).not.toContain('POST /signUp');
    expect(notes).not.toContain('POST /refresh');
    expect(notes).toContain('POST /signIn');
  });

  it('documents the custom sign-up fields', () => {
    const notes = render(
      relationalIps(
        authConfig('ALL_PROTECTED', {
          userFields: [{ name: 'displayName', type: 'string', required: true }],
        }),
      ),
    );
    expect(notes).toContain('displayName');
    expect(notes).toContain('Sign-up fields');
  });

  it('names the protected entities', () => {
    const notes = render(relationalIps(authConfig('ALL_PROTECTED')));
    const built = model(relationalIps(authConfig('ALL_PROTECTED')));
    expect(built.auth.protectedEntities.length).toBeGreaterThan(0);
    expect(notes).toContain(`Protected entities: ${built.auth.protectedEntities.join(', ')}`);
  });
});

describe('§8: determinism', () => {
  it('renders byte-identically twice', () => {
    const ips = relationalIps(authConfig('COMBINATION'));
    expect(render(ips)).toBe(render(ips));
  });

  /**
   * The stronger claim: two *separately constructed* copies of the same
   * definition render identically. A shared object could hide an accidental
   * mutation during rendering.
   */
  it('renders identically from two independent copies', () => {
    const auth = authConfig('ALL_PROTECTED');
    expect(render(relationalIps(auth))).toBe(render(relationalIps(clone(auth))));
  });

  it('does not mutate the definition it documents', () => {
    const ips = relationalIps(authConfig('COMBINATION'));
    const before = JSON.stringify(ips);
    render(ips);
    expect(JSON.stringify(ips)).toBe(before);
  });

  /** No clock in the canonical body — §8 keeps timestamps out or separate. */
  it('contains no timestamp unless one was supplied', () => {
    const notes = render(relationalIps());
    expect(notes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  /**
   * §2 asks for status and published version; §8 requires determinism. They are
   * separated rather than merged, so a reader can tell which half moves.
   */
  it('puts mutable facts under their own heading, and only when supplied', () => {
    const plain = render(relationalIps());
    expect(plain).not.toContain('## Current state');

    const withRuntime = renderTechnicalNotes(
      buildDocumentationModel(relationalIps(), {
        name: 'Shop',
        runtime: { status: 'active', publishedVersion: 3, generatedAt: '2026-09-08T00:00:00.000Z' },
      }),
    );
    expect(withRuntime).toContain('## Current state');
    expect(withRuntime).toContain('Status: active');
    expect(withRuntime).toContain('Published version: v3');
    expect(withRuntime).toContain('2026-09-08T00:00:00.000Z');
  });

  it('distinguishes nothing-published from v1', () => {
    const notes = renderTechnicalNotes(
      buildDocumentationModel(relationalIps(), {
        name: 'Shop',
        runtime: { publishedVersion: null },
      }),
    );
    expect(notes).toContain('nothing published yet');
  });

  /**
   * Endpoints have no stable id — identity is `(method, path)` and Phase 2 left
   * `ep_` unminted — so that pair is the only deterministic key available.
   */
  it('orders endpoints deterministically by method and path', () => {
    const built = model(relationalIps());
    const surface = built.endpoints.filter((endpoint) => !endpoint.isAuthApi);
    const sorted = [...surface].sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    );
    expect(surface.map((e) => `${e.method} ${e.path}`)).toEqual(
      sorted.map((e) => `${e.method} ${e.path}`),
    );
  });

  /**
   * Author order, not id order. §8 asks for sorting by stable id and the goal
   * behind it — a stable rendering — is already met by the stored arrays.
   * Sorting by random `ent_` strings would reorder the schema arbitrarily and
   * make the document less readable, not more stable.
   */
  it('keeps entities in the order the author declared them', () => {
    const ips = relationalIps();
    const built = buildDocumentationModel(ips, { name: 'Shop' });
    expect(built.entities.map((entity) => entity.name)).toEqual(
      ips.entities.map((entity) => entity.name),
    );
  });
});

describe('§26: no secrets, proven', () => {
  /**
   * Searched rather than reasoned about. §26 asks for a test that fails if a
   * forbidden credential field ever appears, and the model has no field for one
   * — this is what keeps that true as the renderer grows.
   */
  const FORBIDDEN = [
    'passwordHash',
    'signingKey',
    'jwtSecret',
    'JWT_SECRET',
    'refreshToken:',
    'accessToken:',
    'tokenHash',
    'mongodb://',
    'mongodb+srv://',
    'redis://',
    'MockAuthSecret',
    'apiKey',
    'secret',
  ];

  it('renders none of the forbidden terms', () => {
    const notes = render(
      relationalIps(
        authConfig('ALL_PROTECTED', {
          cookieAuth: true,
          userFields: [{ name: 'displayName', type: 'string', required: true }],
        }),
      ),
    );
    for (const term of FORBIDDEN) {
      expect(notes.toLowerCase(), term).not.toContain(term.toLowerCase());
    }
  });

  it('carries none of them in the model either', () => {
    // The renderer could be fixed and the model still leak into a future
    // consumer, so both are checked.
    const serialised = JSON.stringify(model(relationalIps(authConfig('ALL_PROTECTED'))));
    for (const term of FORBIDDEN) {
      expect(serialised.toLowerCase(), term).not.toContain(term.toLowerCase());
    }
  });

  /**
   * A field genuinely called something sensitive is the project's own schema,
   * not a leaked credential — but the notes must not print a *value* for it,
   * and nothing here does: only names, types and rules are rendered.
   */
  it('documents a field named like a credential without printing a value', () => {
    const ips = simpleIps();
    ips.entities[0]!.fields.push({
      id: 'fld_secretish',
      name: 'apiToken',
      type: 'string',
      required: false,
      default: null,
      validation: {},
      meta: {},
      children: [],
    });

    const notes = render(ips);
    expect(notes).toContain('apiToken');
    // The name appears; no value does, because the model has no value to give.
    expect(notes).not.toMatch(/apiToken.*=\s*\S{16,}/);
  });
});

describe('an Auth API project', () => {
  const authOnly = (): InternalProjectSchema => ({
    projectId: 'p_auth',
    version: 1,
    kind: 'auth',
    entities: [],
    generationConfig: {
      validators: [],
      types: ['typescript'],
      methods: ['GET', 'POST'],
      mockRecords: 25,
      features: { search: false, filter: false, sort: false, include: false },
    },
    authentication: authConfig('ALL_PUBLIC'),
  });

  it('documents the auth endpoints and says why there is no data model', () => {
    const notes = renderTechnicalNotes(buildDocumentationModel(authOnly(), { name: 'Accounts' }));
    expect(notes).toContain('POST /signIn');
    expect(notes).toContain('GET /me');
    expect(notes).toContain('no entities');
    // Not a bare "No entities." — that reads as missing data rather than as the
    // point of the project kind.
    expect(notes).toContain('Auth API');
  });

  it('produces a document with no entity or relationship content', () => {
    const built = buildDocumentationModel(authOnly(), { name: 'Accounts' });
    expect(built.entities).toEqual([]);
    expect(built.relations).toEqual([]);
  });

  /**
   * It still serves the discovery document, and the notes must say so.
   *
   * `projectEndpoints` emits `GET /` for every project — the base URL answers
   * with the entity catalogue whatever the kind. Asserting "every endpoint is
   * an auth endpoint" was wrong, and the honest claim is narrower: the only
   * *non*-auth endpoint is the index.
   */
  it('still documents the discovery document', () => {
    const built = buildDocumentationModel(authOnly(), { name: 'Accounts' });
    const surface = built.endpoints.filter((endpoint) => !endpoint.isAuthApi);

    expect(surface.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual(['GET /']);
    expect(surface[0]!.requiresAuth).toBe(false);
  });
});

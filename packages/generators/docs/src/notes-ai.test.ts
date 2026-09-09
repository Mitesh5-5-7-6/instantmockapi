import { describe, it, expect } from 'vitest';
import {
  ensureSchemaIds,
  materializeRelations,
  type AuthConfig,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
import { QUERY_FEATURES } from '@instantmockapi/ips';
import { goldenRelationsIPS } from '../../../ips/__tests__/golden-relations-fixture.js';
import { buildDocumentationModel, flattenFields } from './notes-model.js';
import { renderAiContext } from './notes-ai.js';
import { renderTechnicalNotes } from './notes-markdown.js';

/**
 * AI-ready documentation (Phase 4 §7, §25).
 *
 * §25's checklist for this document is: deterministic, complete project
 * context, explicit auth state, explicit endpoint visibility, relationships,
 * validation, no secrets, no runtime credentials. Each has its own describe
 * block below so a gap is visible as a missing group rather than a missing
 * assertion.
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

function ips(auth?: AuthConfig): InternalProjectSchema {
  const document = materializeRelations(clone(goldenRelationsIPS));
  ensureSchemaIds(document);
  return auth === undefined ? document : { ...document, authentication: auth };
}

const model = (document: InternalProjectSchema, runtime?: Record<string, unknown>) =>
  buildDocumentationModel(document, {
    name: 'Shop',
    description: 'A shop',
    ...(runtime === undefined ? {} : { runtime }),
  });

const render = (document: InternalProjectSchema, baseUrl?: string) =>
  renderAiContext(model(document), baseUrl === undefined ? {} : { baseUrl });

/** The `- ` record for one field, located by name. */
const fieldLine = (context: string, name: string): string => {
  const line = context
    .split('\n')
    .find((candidate) => candidate.startsWith(`- ${name} |`));
  if (line === undefined) {
    throw new Error(`no record for field ${name}`);
  }
  return line;
};

/**
 * A record, parsed the way the docstring tells a consumer to parse it: split on
 * unescaped `|`, then unescape. Deliberately not the renderer's own code — a
 * parser written from the documented grammar is what makes these assertions a
 * check on the contract rather than a restatement of the implementation.
 */
const splitRecord = (line: string): string[] =>
  line
    .replace(/^- /, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());

describe('§7: the document shape', () => {
  it('leads with the heading a consumer can anchor on', () => {
    expect(render(ips()).startsWith('# Project Context\n')).toBe(true);
  });

  it('carries every section §7 names', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    for (const heading of [
      '## Project',
      '## Authentication',
      '## Entities',
      '## Relationships',
      '## APIs',
      '## Generation',
    ]) {
      expect(context, heading).toContain(heading);
    }
  });

  /**
   * §7: no assistant-style filler. A consumer must never have to decide whether
   * a line is data or commentary.
   */
  it('contains no conversational prose', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    for (const filler of [
      'Here is',
      'Here are',
      "I've",
      'I have',
      'Let me',
      'Certainly',
      'Overview of your',
      'As you can see',
      'Feel free',
      'you should',
    ]) {
      expect(context, filler).not.toContain(filler);
    }
  });

  it('states scalars as Key: value and records as pipe-delimited lines', () => {
    const context = render(ips());
    expect(context).toMatch(/^Name: Shop$/m);
    expect(context).toMatch(/^Type: \w+$/m);
    expect(context).toMatch(/^Version: \d+$/m);
    // Every list line is a record, and every record uses the same separator.
    const records = context.split('\n').filter((line) => line.startsWith('- '));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((line) => line.includes(' | ') || line.includes(' -> '))).toBe(true);
  });

  it('includes the base URL only when the caller knows it', () => {
    // A guessed base produces client code that fails against the real API.
    expect(render(ips())).not.toContain('Base URL:');
    expect(render(ips(), 'https://api.example.dev/p/prj_a/shop')).toContain(
      'Base URL: https://api.example.dev/p/prj_a/shop',
    );
  });
});

describe('§25: complete project context', () => {
  it('names every entity with its stable id', () => {
    const document = ips();
    const context = render(document);
    const built = model(document);

    for (const entity of built.entities) {
      expect(context, entity.name).toContain(`### ${entity.name}`);
      expect(context, `${entity.name} id`).toContain(`ID: ${entity.id}`);
    }
  });

  it('lists every field, nested ones by dotted path', () => {
    const document = ips();
    const context = render(document);
    const built = model(document);

    for (const entity of built.entities) {
      for (const field of flattenFields(entity.fields)) {
        expect(context, `${entity.name}.${field.path}`).toContain(`- ${field.path} | ${field.type}`);
      }
    }
  });

  /**
   * Dotted paths rather than indentation. Two spaces inside a pipe-delimited
   * list could be structure or formatting; a dotted path cannot be misread —
   * and it is the same string the runtime's query layer and the diff engine
   * use, so an assistant and an API error message name the field identically.
   */
  it('encodes nesting unambiguously', () => {
    const document = ips();
    const built = model(document);
    const nested = built.entities
      .flatMap((entity) => flattenFields(entity.fields))
      .find((field) => field.path.includes('.'));

    if (nested !== undefined) {
      const context = render(document);
      expect(context).toContain(`- ${nested.path} |`);
    }
    // Every field line starts flush; nesting never appears as leading spaces.
    expect(render(document).split('\n').filter((line) => /^\s+- /.test(line))).toEqual([]);
  });

  it('carries the generation configuration', () => {
    const context = render(ips());
    expect(context).toMatch(/^Methods: .+$/m);
    expect(context).toMatch(/^Validators: .+$/m);
    expect(context).toMatch(/^Mock Records Per Entity: \d+$/m);
    expect(context).toMatch(/^Query Features: .+$/m);
  });

  it('describes the same project the human notes describe', () => {
    // §9's reason for a model between the IPS and its documents: both renderers
    // read it, so they cannot disagree about what exists.
    const document = ips(authConfig('COMBINATION'));
    const built = model(document);
    const context = renderAiContext(built);
    const notes = renderTechnicalNotes(built);

    for (const entity of built.entities) {
      expect(context, entity.name).toContain(entity.name);
      expect(notes, entity.name).toContain(entity.name);
    }
    for (const relation of built.relations) {
      expect(context, relation.name).toContain(relation.name);
      expect(notes, relation.name).toContain(relation.name);
    }
  });
});

describe('§25: validation appears', () => {
  it('states each rule as its actual value', () => {
    const document = ips();
    const nested = document.entities[0]!.fields.find((field) => (field.children?.length ?? 0) > 0);
    const leaf = nested?.children[0] ?? document.entities[0]!.fields[1];
    if (leaf === undefined) {
      throw new Error('fixture shape changed');
    }
    leaf.validation = { ...leaf.validation, min: 18, max: 120, email: true };

    const context = render(document);
    expect(context).toContain('min=18');
    expect(context).toContain('max=120');
    expect(context).toContain('email');
  });

  it('states requiredness on every field line', () => {
    // Scoped to the Entities section rather than filtered out of the whole
    // document: relationship and endpoint lines are also `- a | b` records and
    // legitimately carry no requiredness, so a document-wide filter tests the
    // filter rather than the renderer.
    const context = render(ips());
    const entitiesSection = context.split('## Entities')[1]!.split('## Relationships')[0]!;
    const fieldLines = entitiesSection.split('\n').filter((line) => line.startsWith('- '));

    expect(fieldLines.length).toBeGreaterThan(0);
    expect(fieldLines.every((line) => line.includes('required') || line.includes('optional'))).toBe(
      true,
    );
  });

  /**
   * A default is printed only when there is one — and `null` is not one.
   *
   * `zod.ts` and `yup.ts` emit `.default(...)` only for a value that is neither
   * `undefined` nor `null`, and the parsers write `null` as their unset value.
   * Every field in this fixture is `default: null`, so a renderer that tested
   * the value instead of `hasDefault` would put `default=null` on *every* line
   * of the document — an assistant reading it would then generate client code
   * that omits a key expecting the API to store null.
   */
  it('omits the default attribute when the field has no default', () => {
    const context = render(ips());
    expect(context).not.toContain('default=null');
    expect(context).not.toContain('default=');
  });

  it('states a real default, falsy ones included', () => {
    const document = ips();
    const [first, second] = document.entities[0]!.fields;
    if (first === undefined || second === undefined) {
      throw new Error('fixture shape changed');
    }
    first.default = 'draft';
    second.default = 0;

    const context = render(document);
    expect(context).toContain('default="draft"');
    // A truthiness gate would drop this one silently.
    expect(context).toContain('default=0');
  });

  it('marks a foreign key and names the entity it points at', () => {
    const context = render(ips());
    expect(context).toMatch(/foreign key → \w+/);
  });
});

describe('§25: explicit auth state', () => {
  /**
   * One line, the same line every time, so a consumer can match on it. An
   * absent section reads as "not documented", which is a different claim from
   * "not enabled".
   */
  it('says Enabled: false rather than omitting the section', () => {
    const context = render(ips());
    expect(context).toContain('## Authentication');
    expect(context).toContain('Enabled: false');
    expect(context).toContain('no token is required');
  });

  it('documents no lifetimes or endpoints when disabled', () => {
    const context = render(ips());
    expect(context).not.toContain('Access Token TTL');
    expect(context).not.toContain('/signIn');
  });

  it('states the mode, lifetimes and cookie flag when enabled', () => {
    const context = render(
      ips(authConfig('ALL_PROTECTED', { cookieAuth: true, accessTokenExpiresIn: '5m' })),
    );
    expect(context).toContain('Enabled: true');
    expect(context).toContain('Mode: ALL_PROTECTED');
    expect(context).toContain('Cookie Auth: true');
    expect(context).toContain('Access Token TTL: 5m');
    expect(context).toContain('Refresh Token TTL: 7d');
  });

  it('lists the auth endpoints with their token requirement', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    expect(context).toContain('- POST /signIn | public');
    expect(context).toContain('- GET /me | protected');
  });

  it('omits an auth endpoint the project does not generate', () => {
    const context = render(
      ips(authConfig('ALL_PROTECTED', { signup: false, refreshToken: false })),
    );
    expect(context).not.toContain('/signUp');
    expect(context).not.toContain('/refresh');
    expect(context).toContain('/signIn');
  });

  it('lists the custom sign-up fields', () => {
    const context = render(
      ips(
        authConfig('ALL_PROTECTED', {
          userFields: [{ name: 'displayName', type: 'string', required: true }],
        }),
      ),
    );
    expect(context).toContain('- displayName | string | required');
  });
});

describe('§25: explicit endpoint visibility', () => {
  /**
   * Per endpoint, not once per entity: a line copied out of context must not
   * lose its meaning, and an assistant reading only `## APIs` still knows which
   * calls need a token.
   */
  it('marks every endpoint public or protected', () => {
    const context = render(ips(authConfig('COMBINATION')));
    const apiSection = context.split('## APIs')[1]!.split('## Generation')[0]!;
    const lines = apiSection.split('\n').filter((line) => line.startsWith('- '));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.includes('| public |') || line.includes('| protected |'))).toBe(
      true,
    );
  });

  it('uses the resolved requirement, not the stored override', () => {
    const document = ips(authConfig('ALL_PROTECTED'));
    // A stale stamp must not make the document claim an endpoint is open.
    document.entities[0]!.authentication = 'PUBLIC';

    const context = render(document);
    /*
     * Entity endpoints only. The APIs section deliberately also lists the Auth
     * API, whose sign-up and sign-in are *public* by necessity — obtaining a
     * credential cannot require one — and the discovery document, which carries
     * no record data. Asserting "every line protected" would have been asserting
     * something false about a correct document.
     */
    const entityLines = context
      .split('## APIs')[1]!
      .split('## Generation')[0]!
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('- ') &&
          !/\/(signUp|signIn|refresh|me|logout) \|/.test(line) &&
          !line.startsWith('- GET / |'),
      );

    expect(entityLines.length).toBeGreaterThan(0);
    expect(entityLines.every((line) => line.includes('| protected |'))).toBe(true);
  });

  it('marks the discovery document public even on a protected project', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    expect(context).toContain('- GET / | public');
  });

  it('names the request body entity and the path parameters', () => {
    const context = render(ips());
    expect(context).toMatch(/- POST \/\w+ \| public \| body=\w+/);
    expect(context).toMatch(/path=\w+/);
  });
});

describe('§25: relationships', () => {
  it('states source, target, cardinality and cascade for each', () => {
    const document = ips();
    const context = render(document);
    const built = model(document);

    expect(built.relations.length).toBeGreaterThan(0);
    for (const relation of built.relations) {
      expect(context, relation.name).toContain(
        `- ${relation.source}.${relation.name} -> ${relation.target}.${relation.foreignField}`,
      );
      expect(context, relation.cardinality).toContain(relation.cardinality);
    }
    expect(context).toMatch(/on-delete=(restrict|cascade|setNull)/);
  });

  it('says None rather than omitting the section', () => {
    const bare: InternalProjectSchema = {
      ...ips(),
      entities: ips().entities.map((entity) => ({ ...entity, relations: [] })),
    };
    const context = renderAiContext(buildDocumentationModel(bare, { name: 'Shop' }));
    expect(context).toContain('## Relationships');
    expect(context).toContain('None.');
  });
});

describe('§7: deterministic and stable across repeated generation', () => {
  it('renders byte-identically twice', () => {
    const document = ips(authConfig('COMBINATION'));
    expect(render(document)).toBe(render(document));
  });

  /**
   * The determinism claim, stated precisely.
   *
   * §8 is "the **same** canonical Project Definition must produce the same
   * content" — and two separately built fixtures are *not* the same definition,
   * because `ensureSchemaIds` mints fresh random ids each time. The first
   * version of this test compared two independently-minted documents and
   * failed, which was the test asserting something stronger than determinism:
   * that two different definitions render alike.
   *
   * The real claim is that one definition, deep-copied, renders identically —
   * so nothing in the pipeline depends on object identity, insertion order, or
   * anything outside the document itself.
   */
  it('renders identically from a deep copy of the same definition', () => {
    const document = ips(authConfig('ALL_PROTECTED'));
    expect(render(clone(document))).toBe(render(document));
  });

  /** Two independently-minted documents differ only in their ids. */
  it('differs between definitions only where the definitions differ', () => {
    const auth = authConfig('ALL_PROTECTED');
    const stripIds = (context: string) => context.replace(/\b(ent|fld|rel)_[0-9a-z]+/g, '<id>');
    expect(stripIds(render(ips(auth)))).toBe(stripIds(render(ips(clone(auth)))));
  });

  it('does not mutate the definition', () => {
    const document = ips(authConfig('COMBINATION'));
    const before = JSON.stringify(document);
    render(document);
    expect(JSON.stringify(document)).toBe(before);
  });

  /**
   * The reason there is no runtime section here, unlike the human notes.
   *
   * §7 requires output stable across repeated generation, and status moves
   * without the definition changing — so two exports of an unchanged project
   * must not differ because a job finished in between.
   */
  it('ignores runtime facts entirely', () => {
    const document = ips();
    const plain = renderAiContext(model(document));
    const withRuntime = renderAiContext(
      model(document, {
        status: 'active',
        publishedVersion: 7,
        generatedAt: '2026-09-08T00:00:00.000Z',
        hostedUrl: 'https://api.example.dev/p/x',
      }),
    );

    expect(withRuntime).toBe(plain);
    expect(withRuntime).not.toContain('active');
    expect(withRuntime).not.toContain('2026-09-08');
  });

  it('contains no timestamp at all', () => {
    expect(render(ips())).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('ends with exactly one newline, so a diff has no trailing noise', () => {
    const context = render(ips());
    expect(context.endsWith('\n')).toBe(true);
    expect(context.endsWith('\n\n')).toBe(false);
  });
});

describe('§25/§26: no secrets, no runtime credentials', () => {
  const FORBIDDEN = [
    'passwordHash',
    'signingKey',
    'jwtSecret',
    'JWT_SECRET',
    'tokenHash',
    'mongodb://',
    'mongodb+srv://',
    'redis://',
    'MockAuthSecret',
    'apiKey',
    'secret',
    'Bearer ey',
  ];

  it('renders none of the forbidden terms', () => {
    const context = render(
      ips(
        authConfig('ALL_PROTECTED', {
          cookieAuth: true,
          userFields: [{ name: 'displayName', type: 'string', required: true }],
        }),
      ),
    );
    for (const term of FORBIDDEN) {
      expect(context.toLowerCase(), term).not.toContain(term.toLowerCase());
    }
  });

  /**
   * A token TTL is configuration; a token is a credential. The document carries
   * the first and has no way to carry the second — `NotesAuth` has no field for
   * one.
   */
  it('documents lifetimes without documenting a token', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    expect(context).toContain('Access Token TTL: 15m');
    // No JWT-shaped string anywhere.
    expect(context).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
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

  it('states that there are no entities rather than truncating', () => {
    const context = renderAiContext(buildDocumentationModel(authOnly(), { name: 'Accounts' }));
    expect(context).toContain('## Entities');
    expect(context).toContain('None. This project has no entities.');
    expect(context).toContain('Type: auth');
  });

  it('still documents the auth endpoints and the discovery document', () => {
    const context = renderAiContext(buildDocumentationModel(authOnly(), { name: 'Accounts' }));
    expect(context).toContain('- POST /signIn | public');
    expect(context).toContain('- GET /me | protected');
    expect(context).toContain('- GET / | public');
  });
});

describe('§7: the record grammar holds for hostile values', () => {
  /**
   * `|` is the record separator *and* the separator `describeValidation` uses
   * inside an `enum` rule, and a `regex` rule commonly contains one:
   * `^(draft|live)$` is an ordinary constraint, not a contrived input. Without
   * escaping, one field silently becomes three and a consumer splitting the
   * line reads `live)$` as a trait.
   */
  it('escapes a pipe inside a regex rule', () => {
    const document = ips();
    const field = document.entities[0]!.fields[0]!;
    field.validation = { ...field.validation, regex: '^(draft|live)$' };

    const line = fieldLine(render(document), field.name);
    expect(line).toContain('regex=^(draft\\|live)$');
    // The rule is one field, so the record keeps its arity.
    expect(splitRecord(line)).toContain('regex=^(draft|live)$');
  });

  it('escapes the pipes inside an enum rule', () => {
    const document = ips();
    const field = document.entities[0]!.fields[0]!;
    field.validation = { ...field.validation, enum: ['draft', 'live'] };

    const cells = splitRecord(fieldLine(render(document), field.name));
    expect(cells).toContain('enum=draft|live');
  });

  it('escapes a pipe inside a default value', () => {
    const document = ips();
    const field = document.entities[0]!.fields[0]!;
    field.default = 'a|b';

    expect(splitRecord(fieldLine(render(document), field.name))).toContain('default="a|b"');
  });

  /**
   * A description is unconstrained text and this document's structure is
   * carried entirely by line breaks — so a description can otherwise forge a
   * heading or a fact, and the machine reading it cannot tell the difference.
   */
  it('flattens a newline in free text rather than letting it forge a fact', () => {
    const context = renderAiContext(
      buildDocumentationModel(ips(), {
        name: 'Shop',
        description: 'Fine\n\n## Authentication\nEnabled: false\n',
      }),
    );

    expect(context.split('\n').filter((line) => line === '## Authentication')).toHaveLength(1);
    // The real state is `Enabled: false` for this fixture, so the forgery would
    // be invisible by collision — count it rather than look for it.
    expect(context.split('\n').filter((line) => line === 'Enabled: false')).toHaveLength(1);
    expect(context).toContain('Fine');
  });
});

describe('§7: one record shape for one endpoint', () => {
  /**
   * The Auth API is listed twice — under `## Authentication` for the flow, and
   * in the full surface. Two *shapes* for the same endpoint is the ambiguity
   * this document is meant to be free of: a consumer counting fields sees
   * inconsistent arity and can read one endpoint as two.
   */
  it('renders an auth endpoint identically in both sections', () => {
    const context = render(ips(authConfig('ALL_PROTECTED')));
    const signIn = context
      .split('\n')
      .filter((line) => line.startsWith('- POST /signIn |'));

    expect(signIn).toHaveLength(2);
    expect(signIn[0]).toEqual(signIn[1]);
  });

  it('states the response shape of every auth endpoint', () => {
    // Without it a consumer knows the path and nothing about what comes back.
    const context = render(ips(authConfig('ALL_PROTECTED')));
    for (const line of context.split('\n').filter((l) => /^- (POST|GET) \/(signIn|me)/.test(l))) {
      expect(line, line).toMatch(/response=\w+/);
    }
  });
});

describe('§25: the document is addressable', () => {
  /**
   * Every path in this document is relative. Without the routing identity an
   * assistant has nothing to hang them on, and `baseUrl` is not always known —
   * a caller documenting a historical version has the parts and no live URL.
   */
  it('states the public id and base path when the project has them', () => {
    const document = ips();
    const context = renderAiContext(
      buildDocumentationModel({ ...document, publicId: 'prj_abc1234', slug: 'shop' }, {
        name: 'Shop',
      }),
    );

    expect(context).toContain('Public ID: prj_abc1234');
    expect(context).toContain('Base Path: /shop');
  });
});

describe('§7: empty sections say so', () => {
  it('says None under Fields rather than leaving a bare heading', () => {
    const document = ips();
    document.entities[0]!.fields = [];

    const context = render(document);
    const fieldsIndex = context.split('\n').findIndex((line) => line === '#### Fields');
    expect(fieldsIndex).toBeGreaterThan(-1);
    expect(context.split('\n')[fieldsIndex + 1]).toBe('None.');
  });
});

describe('§7: the query-feature vocabulary is shared, not copied', () => {
  /**
   * A re-declared list is the silent kind of wrong: a fifth feature added to
   * the IPS would simply never appear in either document, and no test would
   * fail. Reading the shared constant makes the coverage structural.
   */
  it('can render every feature the IPS defines', () => {
    const document = ips();
    document.generationConfig = {
      ...document.generationConfig,
      features: Object.fromEntries(
        QUERY_FEATURES.map((feature) => [feature, true]),
      ) as typeof document.generationConfig.features,
    };

    const line = render(document)
      .split('\n')
      .find((candidate) => candidate.startsWith('Query Features: '));

    expect(line).toBeDefined();
    for (const feature of QUERY_FEATURES) {
      expect(line, feature).toContain(feature);
    }
  });
});

import { describe, it, expect } from 'vitest';
import type { AuthConfig, AuthMode, InternalProjectSchema } from '@instantmockapi/ips';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { generateOpenAPI } from './openapi.js';
import { generatePostmanCollection } from './postman.js';

/**
 * Authentication in the generated documentation (Phase 3 §19, §20).
 *
 * Two claims run through all of it:
 *
 * - The docs and the runtime agree about which entities are protected, because
 *   both read `entityAuth` rather than re-deriving from the mode.
 * - No credential is ever written into an artifact. Both files ship inside the
 *   export bundle and may be committed to a repository.
 */

type Node = Record<string, any>;

function authConfig(mode: AuthMode, over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    mode,
    signup: true,
    signin: true,
    refreshToken: true,
    cookieAuth: false,
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    userFields: [],
    ...over,
  };
}

const base = () => JSON.parse(JSON.stringify(goldenFixtureIPS)) as InternalProjectSchema;

/** The fixture has one entity, `BlogPost`, at `/blogpost`. */
const ENTITY = 'BlogPost';
const PATH = '/blogpost';

function withAuth(auth: AuthConfig | null, stamp?: 'PUBLIC' | 'PROTECTED'): InternalProjectSchema {
  const ips = base();
  if (auth !== null) {
    ips.authentication = auth;
  }
  if (stamp !== undefined) {
    ips.entities[0]!.authentication = stamp;
  }
  return ips;
}

const spec = (ips: InternalProjectSchema): Node =>
  JSON.parse(generateOpenAPI(ips)['openapi.json']!) as Node;

const collection = (ips: InternalProjectSchema): Node =>
  JSON.parse(generatePostmanCollection(ips)['postman_collection.json']!) as Node;

const folderNamed = (doc: Node, name: string): Node | undefined =>
  (doc['item'] as Node[]).find((entry) => entry['name'] === name);

describe('§26: a project with authentication off', () => {
  /**
   * The compatibility guarantee, and the reason both generators gate on
   * `authEnabled` rather than emitting an all-off block.
   */
  it('produces an OpenAPI document with no security machinery', () => {
    const document = spec(withAuth(null));
    expect(document['components']['securitySchemes']).toBeUndefined();
    expect(document['paths']['/signUp']).toBeUndefined();
    expect(document['paths']['/me']).toBeUndefined();

    const operation = document['paths'][PATH]['get'] as Node;
    expect(operation['security']).toBeUndefined();
  });

  it('produces a Postman collection with no Authentication folder', () => {
    const document = collection(withAuth(null));
    expect(folderNamed(document, 'Authentication')).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('accessToken');
  });
});

describe('§19: the Auth API in OpenAPI', () => {
  it('documents all five endpoints', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED')))['paths'] as Node;
    expect(paths['/signUp']['post']).toBeDefined();
    expect(paths['/signIn']['post']).toBeDefined();
    expect(paths['/refresh']['post']).toBeDefined();
    expect(paths['/me']['get']).toBeDefined();
    expect(paths['/logout']['post']).toBeDefined();
  });

  /**
   * A disabled endpoint is omitted, not documented as unavailable: the runtime
   * 404s it, and a spec listing a route that does not exist is a spec that lies.
   */
  it('omits an endpoint the project turned off', () => {
    const paths = spec(
      withAuth(authConfig('ALL_PROTECTED', { signup: false, refreshToken: false })),
    )['paths'] as Node;
    expect(paths['/signUp']).toBeUndefined();
    expect(paths['/refresh']).toBeUndefined();
    // /signIn, /me and /logout always exist while authentication is on.
    expect(paths['/signIn']).toBeDefined();
    expect(paths['/me']).toBeDefined();
  });

  /** Obtaining a credential cannot itself require one. */
  it('leaves signUp, signIn and refresh unsecured', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED')))['paths'] as Node;
    expect(paths['/signUp']['post']['security']).toEqual([]);
    expect(paths['/signIn']['post']['security']).toEqual([]);
    expect(paths['/refresh']['post']['security']).toEqual([]);
  });

  it('secures /me', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED')))['paths'] as Node;
    expect(paths['/me']['get']['security']).toEqual([{ bearerAuth: [] }]);
  });

  it('declares a bearer scheme, and a cookie scheme only in cookie mode', () => {
    const plain = spec(withAuth(authConfig('ALL_PROTECTED')))['components']['securitySchemes'];
    expect(plain['bearerAuth']['scheme']).toBe('bearer');
    expect(plain['cookieAuth']).toBeUndefined();

    const cookies = spec(withAuth(authConfig('ALL_PROTECTED', { cookieAuth: true })))['components'][
      'securitySchemes'
    ];
    expect(cookies['bearerAuth']).toBeDefined();
    expect(cookies['cookieAuth']['in']).toBe('cookie');
  });

  /**
   * An array of alternatives, not one requirement with two keys.
   *
   * OpenAPI reads the keys inside a single requirement object as *all*
   * required, so `{bearerAuth: [], cookieAuth: []}` would document an API that
   * demands a header and a cookie together. The runtime accepts either.
   */
  it('documents the header and the cookie as alternatives', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED', { cookieAuth: true })))['paths'] as Node;
    expect(paths['/me']['get']['security']).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
  });

  it('documents the custom signup fields, including which are required', () => {
    const document = spec(
      withAuth(
        authConfig('ALL_PROTECTED', {
          userFields: [
            { name: 'displayName', type: 'string', required: true },
            { name: 'age', type: 'number', required: false },
          ],
        }),
      ),
    );
    const body =
      document['paths']['/signUp']['post']['requestBody']['content']['application/json']['schema'];
    expect(body['properties']['displayName']).toEqual({ type: 'string' });
    expect(body['properties']['age']).toEqual({ type: 'number' });
    expect(body['required']).toContain('displayName');
    expect(body['required']).not.toContain('age');
  });

  /**
   * §10: the documented user shape must be what `publicUser` actually emits.
   * A documented `passwordHash` would be a documented vulnerability.
   */
  it('never documents a password field on the user', () => {
    const document = spec(withAuth(authConfig('ALL_PROTECTED')));
    const user = document['components']['schemas']['AuthUser'];
    expect(Object.keys(user['properties'])).not.toContain('passwordHash');
    expect(Object.keys(user['properties'])).not.toContain('password');
  });

  /**
   * A documented `accessToken` that never arrives is worse than no
   * documentation, because a client gets written against it.
   */
  it('omits the body tokens in cookie mode', () => {
    const cookieMode = spec(withAuth(authConfig('ALL_PROTECTED', { cookieAuth: true })));
    const response =
      cookieMode['paths']['/signIn']['post']['responses']['200']['content']['application/json'][
        'schema'
      ];
    expect(response['properties']['accessToken']).toBeUndefined();
    expect(response['properties']['user']).toBeDefined();

    const headerMode = spec(withAuth(authConfig('ALL_PROTECTED')));
    const plain =
      headerMode['paths']['/signIn']['post']['responses']['200']['content']['application/json'][
        'schema'
      ];
    expect(plain['properties']['accessToken']).toBeDefined();
  });
});

describe('§19: per-entity security', () => {
  it('secures every operation of a protected entity, including DELETE', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED')))['paths'] as Node;
    const operations = [
      paths[PATH]['get'],
      paths[PATH]['post'],
      paths[`${PATH}/{recordId}`]['get'],
      paths[`${PATH}/{recordId}`]['put'],
      paths[`${PATH}/{recordId}`]['delete'],
    ].filter((operation) => operation !== undefined) as Node[];

    expect(operations.length).toBeGreaterThan(3);
    for (const operation of operations) {
      expect(operation['security']).toEqual([{ bearerAuth: [] }]);
      expect(operation['responses']['401']).toBeDefined();
    }
  });

  it('leaves a public entity unsecured under ALL_PUBLIC', () => {
    const paths = spec(withAuth(authConfig('ALL_PUBLIC')))['paths'] as Node;
    expect(paths[PATH]['get']['security']).toBeUndefined();
    expect(paths[PATH]['get']['responses']['401']).toBeUndefined();
  });

  it('follows the resolved value in COMBINATION mode', () => {
    const open = spec(withAuth(authConfig('COMBINATION'), 'PUBLIC'))['paths'] as Node;
    expect(open[PATH]['get']['security']).toBeUndefined();

    const closed = spec(withAuth(authConfig('COMBINATION'), 'PROTECTED'))['paths'] as Node;
    expect(closed[PATH]['get']['security']).toEqual([{ bearerAuth: [] }]);
  });

  /**
   * The docs must not disagree with the runtime about a stale stamp. The mode
   * wins there, so it must win here.
   */
  it('ignores a stale PUBLIC stamp under ALL_PROTECTED', () => {
    const paths = spec(withAuth(authConfig('ALL_PROTECTED'), 'PUBLIC'))['paths'] as Node;
    expect(paths[PATH]['get']['security']).toEqual([{ bearerAuth: [] }]);
  });

  /** §19 asks that PUBLIC/PROTECTED be clearly shown, not only machine-readable. */
  it('says PUBLIC or PROTECTED in the entity tag a human reads', () => {
    const closed = spec(withAuth(authConfig('ALL_PROTECTED')))['tags'] as Node[];
    expect(closed.find((tag) => tag['name'] === ENTITY)!['description']).toContain('PROTECTED');

    const open = spec(withAuth(authConfig('ALL_PUBLIC')))['tags'] as Node[];
    expect(open.find((tag) => tag['name'] === ENTITY)!['description']).toContain('PUBLIC');
  });

  it('keeps the author’s own entity description alongside the note', () => {
    const ips = withAuth(authConfig('ALL_PROTECTED'));
    ips.entities[0]!.description = 'Posts on the blog.';
    const tags = spec(ips)['tags'] as Node[];
    const description = tags.find((tag) => tag['name'] === ENTITY)!['description'] as string;
    expect(description).toContain('Posts on the blog.');
    expect(description).toContain('PROTECTED');
  });
});

describe('§20: the Postman collection', () => {
  it('puts an Authentication folder first, with the five requests', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED')));
    const first = (document['item'] as Node[])[0]!;
    expect(first['name']).toBe('Authentication');
    expect((first['item'] as Node[]).map((request) => request['name'])).toEqual([
      'Sign Up',
      'Sign In',
      'Refresh',
      'Me',
      'Logout',
    ]);
  });

  it('omits a request for an endpoint the project turned off', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED', { signup: false })));
    const names = (folderNamed(document, 'Authentication')!['item'] as Node[]).map(
      (request) => request['name'],
    );
    expect(names).not.toContain('Sign Up');
    expect(names).toContain('Sign In');
  });

  it('sends {{accessToken}} on a protected entity request', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED')));
    const requests = folderNamed(document, ENTITY)!['item'] as Node[];
    for (const request of requests) {
      const headers = (request['request']['header'] as Node[]).map((header) => header['value']);
      expect(headers, request['name'] as string).toContain('Bearer {{accessToken}}');
    }
  });

  /**
   * Per request rather than collection-level auth: a COMBINATION project has
   * both kinds, and a collection-level token would be sent to the public
   * entities too — misrepresenting which endpoints need credentials.
   */
  it('does not send a token on a public entity request', () => {
    const document = collection(withAuth(authConfig('ALL_PUBLIC')));
    const requests = folderNamed(document, ENTITY)!['item'] as Node[];
    for (const request of requests) {
      const headers = (request['request']['header'] as Node[]).map((header) => header['value']);
      expect(headers, request['name'] as string).not.toContain('Bearer {{accessToken}}');
    }
  });

  it('keeps the Content-Type header on writes as well as the token', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED')));
    const create = (folderNamed(document, ENTITY)!['item'] as Node[]).find(
      (request) => request['name'] === `Create ${ENTITY}`,
    )!;
    const headers = (create['request']['header'] as Node[]).map((header) => header['key']);
    expect(headers).toContain('Content-Type');
    expect(headers).toContain('Authorization');
  });

  /**
   * §20: no real tokens in an exported collection. Every credential is an empty
   * variable — the file ships in the export bundle and may be committed.
   */
  it('exports every credential variable empty', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED')));
    const variables = document['variable'] as Node[];
    for (const key of ['authEmail', 'authPassword', 'accessToken', 'refreshToken']) {
      const variable = variables.find((entry) => entry['key'] === key);
      expect(variable, key).toBeDefined();
      expect(variable!['value'], key).toBe('');
    }
  });

  it('marks the credential variables secret so Postman masks them', () => {
    const variables = collection(withAuth(authConfig('ALL_PROTECTED')))['variable'] as Node[];
    for (const key of ['authPassword', 'accessToken', 'refreshToken']) {
      expect(variables.find((entry) => entry['key'] === key)!['type'], key).toBe('secret');
    }
  });

  /**
   * The capture script is what makes the collection usable: without it
   * `{{accessToken}}` is a placeholder the user re-fills by hand every session.
   */
  it('captures the tokens from Sign In into collection variables', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED')));
    const signIn = (folderNamed(document, 'Authentication')!['item'] as Node[]).find(
      (request) => request['name'] === 'Sign In',
    )!;
    const script = ((signIn['event'] as Node[])[0]!['script']['exec'] as string[]).join('\n');
    expect(script).toContain('pm.collectionVariables.set');
    expect(script).toContain('accessToken');
    // Guarded, because a cookie-mode response carries no tokens and setting
    // `undefined` would overwrite a good token with the string "undefined".
    expect(script).toContain('if (body.accessToken)');
  });

  it('omits the refresh body in cookie mode, where the browser carries it', () => {
    const document = collection(withAuth(authConfig('ALL_PROTECTED', { cookieAuth: true })));
    const refresh = (folderNamed(document, 'Authentication')!['item'] as Node[]).find(
      (request) => request['name'] === 'Refresh',
    )!;
    expect(refresh['request']['body']).toBeUndefined();
  });
});

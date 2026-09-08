/**
 * The Auth API in OpenAPI (Phase 3 §19).
 *
 * Three things §19 asks for, and each is a separate mechanism in the spec:
 *
 * 1. The five endpoints as documented paths.
 * 2. A `bearerAuth` security scheme, plus `cookieAuth` when the project uses it.
 * 3. Per-operation `security`, so a protected entity requires a token and a
 *    public one demonstrably does not.
 *
 * ## Why `security` goes on the operation, not the document
 *
 * A document-level `security` block applies to everything and is then switched
 * off per operation with `security: []`. That reads backwards for a
 * `COMBINATION` project — the public entities would each carry an explicit
 * "no really, this one is open" — and, worse, an operation that simply forgot to
 * declare anything would inherit protection it does not have. Declaring it per
 * operation makes the generated spec agree with the runtime by construction:
 * both read the same resolved answer, per entity.
 */

import type { AuthConfig, AuthUserField } from '@instantmockapi/ips';

/** Loose node type, matching the rest of this generator. */
type Node = Record<string, unknown>;

export const BEARER_SCHEME = 'bearerAuth';
export const COOKIE_SCHEME = 'cookieAuth';

/**
 * The security schemes a project's configuration implies.
 *
 * Cookie mode adds a scheme rather than replacing the bearer one: the runtime
 * accepts either, preferring the header, so documenting only cookies would make
 * the spec narrower than the API.
 */
export function securitySchemes(auth: AuthConfig): Node {
  return {
    [BEARER_SCHEME]: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Access token from POST /signIn, sent as `Authorization: Bearer <token>`.',
    },
    ...(auth.cookieAuth
      ? {
          [COOKIE_SCHEME]: {
            type: 'apiKey',
            in: 'cookie',
            name: 'ima_access',
            description:
              'HttpOnly access cookie, set by POST /signIn. Sent automatically by the browser.',
          },
        }
      : {}),
  };
}

/**
 * The `security` value for a protected operation.
 *
 * An **array of alternatives**, not one object with two keys: OpenAPI reads the
 * keys within a single requirement object as *all* required, so
 * `{bearerAuth: [], cookieAuth: []}` would document an API that demands a
 * header and a cookie together. The runtime accepts either.
 */
export function protectedSecurity(auth: AuthConfig): Node[] {
  return [
    { [BEARER_SCHEME]: [] },
    ...(auth.cookieAuth ? [{ [COOKIE_SCHEME]: [] }] : []),
  ];
}

/** JSON-schema type for a custom signup field. */
function userFieldSchema(field: AuthUserField): Node {
  return { type: field.type };
}

/**
 * The signup request body, including the project's custom fields (§5).
 *
 * `passwordHash` and friends cannot appear here: `validateIPS` rejects those
 * names as custom fields, so the reserved set is enforced before this runs.
 */
function signUpBody(auth: AuthConfig): Node {
  const properties: Node = {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, maxLength: 200 },
  };
  const required = ['email', 'password'];

  for (const field of auth.userFields) {
    properties[field.name] = userFieldSchema(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return { type: 'object', required, properties };
}

/**
 * The user shape every auth response returns.
 *
 * §10: no `passwordHash`, no tokens, no session data. Generated from the
 * declared custom fields, so the documented shape is exactly what
 * `publicUser` emits.
 */
function userSchema(auth: AuthConfig): Node {
  const properties: Node = {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  };
  for (const field of auth.userFields) {
    properties[field.name] = userFieldSchema(field);
  }
  return { type: 'object', properties };
}

/**
 * The signin/signup response.
 *
 * In cookie mode the tokens are absent from the body by design, and the spec
 * has to say so — a documented `accessToken` that never arrives is worse than
 * no documentation, because a client will be written against it.
 */
function sessionSchema(auth: AuthConfig): Node {
  return {
    type: 'object',
    properties: {
      user: { $ref: '#/components/schemas/AuthUser' },
      ...(auth.cookieAuth
        ? {}
        : {
            accessToken: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            ...(auth.refreshToken ? { refreshToken: { type: 'string' } } : {}),
          }),
    },
  };
}

const AUTH_TAG = 'Authentication';

const errorResponse = (description: string): Node => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonBody = (schema: Node): Node => ({
  required: true,
  content: { 'application/json': { schema } },
});

const jsonResponse = (description: string, schema: Node): Node => ({
  description,
  content: { 'application/json': { schema } },
});

/**
 * Paths for the Auth API, honouring which endpoints the project generates.
 *
 * A disabled endpoint is **omitted**, not documented as unavailable: the
 * runtime 404s it, and a spec listing a route that does not exist is a spec
 * that lies. `/me` and `/logout` always exist while authentication is on.
 */
export function authPaths(auth: AuthConfig): Node {
  const paths: Node = {};
  const security = protectedSecurity(auth);

  if (auth.signup) {
    paths['/signUp'] = {
      post: {
        operationId: 'signUp',
        summary: 'Create an account',
        tags: [AUTH_TAG],
        // No `security`: obtaining a credential cannot require one.
        security: [],
        requestBody: jsonBody(signUpBody(auth)),
        responses: {
          '201': jsonResponse('Account created and signed in', sessionSchema(auth)),
          '409': errorResponse('An account with that email already exists'),
          '422': errorResponse('Invalid email, password or signup field'),
          '429': errorResponse('Too many credential attempts'),
        },
      },
    };
  }

  if (auth.signin) {
    paths['/signIn'] = {
      post: {
        operationId: 'signIn',
        summary: 'Sign in',
        tags: [AUTH_TAG],
        security: [],
        requestBody: jsonBody({
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          },
        }),
        responses: {
          '200': jsonResponse('Signed in', sessionSchema(auth)),
          // §6: one answer for a wrong password and an unknown address, and the
          // documentation must not imply otherwise.
          '401': errorResponse('Invalid email or password'),
          '429': errorResponse('Too many credential attempts'),
        },
      },
    };
  }

  if (auth.refreshToken) {
    paths['/refresh'] = {
      post: {
        operationId: 'refresh',
        summary: 'Exchange a refresh token for a new access token',
        tags: [AUTH_TAG],
        security: [],
        ...(auth.cookieAuth
          ? {}
          : {
              requestBody: jsonBody({
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              }),
            }),
        responses: {
          '200': jsonResponse('Rotated', sessionSchema(auth)),
          '401': errorResponse('The refresh token is unknown, expired or already used'),
          '429': errorResponse('Too many credential attempts'),
        },
      },
    };
  }

  paths['/me'] = {
    get: {
      operationId: 'me',
      summary: 'The signed-in user',
      tags: [AUTH_TAG],
      security,
      responses: {
        '200': jsonResponse('The signed-in user', {
          type: 'object',
          properties: { user: { $ref: '#/components/schemas/AuthUser' } },
        }),
        '401': errorResponse('Missing or invalid access token'),
      },
    },
  };

  paths['/logout'] = {
    post: {
      operationId: 'logout',
      summary: 'Revoke the refresh session',
      tags: [AUTH_TAG],
      // Deliberately open: the caller who most needs logout is the one whose
      // access token has already lapsed. The runtime answers 204 either way.
      security: [],
      responses: { '204': { description: 'Signed out' } },
    },
  };

  return paths;
}

/** The `AuthUser` component the auth paths reference. */
export function authSchemas(auth: AuthConfig): Node {
  return { AuthUser: userSchema(auth) };
}

/** The tag description, so Swagger UI groups the five endpoints with an explanation. */
export function authTag(auth: AuthConfig): Node {
  return {
    name: AUTH_TAG,
    description: auth.cookieAuth
      ? 'Sign up and sign in. Tokens are set as HttpOnly cookies rather than returned in the body.'
      : 'Sign up and sign in, then send `Authorization: Bearer <accessToken>` on protected endpoints.',
  };
}

/**
 * A one-line note for an entity's tag saying whether it needs a token (§19).
 *
 * §19 asks that PUBLIC and PROTECTED be *clearly shown* per entity. The
 * `security` block is the machine-readable half; this is the half a human
 * reading Swagger UI sees without opening an operation.
 */
export function entityAuthNote(requiresAuth: boolean): string {
  return requiresAuth
    ? 'PROTECTED — requires an access token.'
    : 'PUBLIC — no authentication required.';
}

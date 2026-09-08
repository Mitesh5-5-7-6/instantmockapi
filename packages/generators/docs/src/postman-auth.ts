/**
 * The Authentication folder in a Postman collection (Phase 3 §20).
 *
 *     Authentication
 *     ├── Sign Up
 *     ├── Sign In
 *     ├── Refresh
 *     ├── Me
 *     └── Logout
 *
 * ## The collection is a working credential flow, not five example requests
 *
 * Sign In captures the tokens into collection variables from a test script, so
 * the protected requests in the entity folders authenticate with no copying and
 * pasting. Without that, `{{accessToken}}` is a placeholder the user has to
 * fill in by hand on every session — which is the difference between a
 * collection somebody uses and one they delete.
 *
 * ## §20: no real tokens are exported
 *
 * Every credential is a **variable with an empty value**. The collection is an
 * artifact in the export bundle and may be committed to a repository, so a
 * captured token baked into it would be a leaked credential with a seven-day
 * life. The values arrive only when the user runs Sign In themselves.
 *
 * The password variable is empty for the same reason, and Postman's `secret`
 * variable type keeps both out of the UI in plain text.
 */

import type { AuthConfig } from '@instantmockapi/ips';

type Node = Record<string, unknown>;

const JSON_HEADER = [{ key: 'Content-Type', value: 'application/json' }];

/** The variable the protected entity requests read. */
export const ACCESS_TOKEN_VARIABLE = 'accessToken';
export const REFRESH_TOKEN_VARIABLE = 'refreshToken';

/**
 * `Authorization: Bearer {{accessToken}}` — the header §20 asks for.
 *
 * Emitted per request rather than as collection-level auth, because a
 * `COMBINATION` project has both public and protected entities: collection-level
 * auth would send a token to the public ones too. Harmless at runtime (the
 * runtime ignores an unnecessary header) but misleading in a collection someone
 * reads to learn which endpoints need credentials.
 */
export function bearerHeader(): Node[] {
  return [{ key: 'Authorization', value: `Bearer {{${ACCESS_TOKEN_VARIABLE}}}` }];
}

function url(segments: string[]): Node {
  return {
    raw: ['{{baseUrl}}', ...segments].join('/'),
    host: ['{{baseUrl}}'],
    path: segments,
  };
}

function jsonBody(payload: Node): Node {
  return { mode: 'raw', raw: JSON.stringify(payload, null, 2), options: { raw: { language: 'json' } } };
}

/**
 * A test script that captures the tokens Sign In returned.
 *
 * Guarded on the field being present, because a cookie-mode project returns no
 * tokens in the body at all — the browser holds them. Setting `undefined` there
 * would overwrite a previously captured token with the string "undefined" and
 * every protected request would then fail with a credential that looks valid.
 */
function captureScript(auth: AuthConfig): Node {
  const lines = [
    'const body = pm.response.json();',
    'if (body.accessToken) {',
    `  pm.collectionVariables.set('${ACCESS_TOKEN_VARIABLE}', body.accessToken);`,
    '}',
    ...(auth.refreshToken
      ? [
          'if (body.refreshToken) {',
          `  pm.collectionVariables.set('${REFRESH_TOKEN_VARIABLE}', body.refreshToken);`,
          '}',
        ]
      : []),
  ];
  return {
    listen: 'test',
    script: { type: 'text/javascript', exec: lines },
  };
}

/** The signup body, including the project's declared custom fields (§5). */
function signUpBody(auth: AuthConfig): Node {
  const payload: Node = { email: '{{authEmail}}', password: '{{authPassword}}' };
  for (const field of auth.userFields) {
    // A shape hint, not a value: the user fills these in. Strings get an empty
    // string rather than a fake name, so nothing in the collection reads as
    // real data.
    payload[field.name] = field.type === 'number' ? 0 : field.type === 'boolean' ? false : '';
  }
  return payload;
}

/**
 * The Authentication folder.
 *
 * Only called when the project has an Auth API — the caller gates on
 * `authEnabled`, because §26's projects must produce the collection they always
 * did and an empty "Authentication" folder would be a visible change for a
 * project that has none.
 */
export function authFolder(auth: AuthConfig): Node {
  const requests: Node[] = [];

  if (auth.signup) {
    requests.push({
      name: 'Sign Up',
      event: [captureScript(auth)],
      request: {
        method: 'POST',
        header: JSON_HEADER,
        body: jsonBody(signUpBody(auth)),
        url: url(['signUp']),
      },
    });
  }

  if (auth.signin) {
    requests.push({
      name: 'Sign In',
      // The one request that makes the rest of the collection work.
      event: [captureScript(auth)],
      request: {
        method: 'POST',
        header: JSON_HEADER,
        body: jsonBody({ email: '{{authEmail}}', password: '{{authPassword}}' }),
        url: url(['signIn']),
      },
    });
  }

  if (auth.refreshToken) {
    requests.push({
      name: 'Refresh',
      event: [captureScript(auth)],
      request: {
        method: 'POST',
        header: JSON_HEADER,
        // Cookie mode sends no body — the browser carries the refresh cookie —
        // so documenting one would describe a request the runtime ignores.
        ...(auth.cookieAuth
          ? {}
          : { body: jsonBody({ refreshToken: `{{${REFRESH_TOKEN_VARIABLE}}}` }) }),
        url: url(['refresh']),
      },
    });
  }

  requests.push({
    name: 'Me',
    request: { method: 'GET', header: bearerHeader(), url: url(['me']) },
  });

  requests.push({
    name: 'Logout',
    request: {
      method: 'POST',
      header: JSON_HEADER,
      ...(auth.cookieAuth
        ? {}
        : { body: jsonBody({ refreshToken: `{{${REFRESH_TOKEN_VARIABLE}}}` }) }),
      url: url(['logout']),
    },
  });

  return {
    name: 'Authentication',
    description:
      'Run Sign In first — it captures the tokens into collection variables, so the ' +
      'protected requests below authenticate without any copying. Set authEmail and ' +
      'authPassword before you start.',
    item: requests,
  };
}

/**
 * Collection variables the auth flow needs, all empty (§20).
 *
 * `secret` rather than `default` for the three credentials, so Postman masks
 * them in its UI. Empty values mean the exported artifact carries no
 * credential — the whole point.
 */
export function authVariables(auth: AuthConfig): Node[] {
  return [
    { key: 'authEmail', value: '', type: 'default' },
    { key: 'authPassword', value: '', type: 'secret' },
    { key: ACCESS_TOKEN_VARIABLE, value: '', type: 'secret' },
    ...(auth.refreshToken ? [{ key: REFRESH_TOKEN_VARIABLE, value: '', type: 'secret' }] : []),
  ];
}

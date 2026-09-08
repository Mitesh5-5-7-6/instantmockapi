/**
 * Teaching public-vs-protected at project creation (Phase 3 §1, §2, §25).
 *
 * The Auth tab lets somebody change this later, and that was working before
 * this file existed. What was missing is the *first* encounter: a user who is
 * never asked does not learn that the concept exists, finds every endpoint open,
 * and has no reason to go looking for a tab about it.
 *
 * So the wizard asks — once, in plain language, with the consequence shown
 * rather than described.
 *
 * ## Two different questions, per the spec
 *
 * §1 gives a Single API a bare **"Need authentication? Yes/No"** and says
 * explicitly not to expose the full Project API configuration there. §2 gives a
 * Project API the three-way choice, because a project with several entities is
 * where "some of them" is the common answer. This module serves both: the
 * Single flow uses `SIMPLE_CHOICES`, the Project flow uses `PROJECT_CHOICES`.
 *
 * ## Why the copy avoids the vocabulary
 *
 * "PUBLIC", "PROTECTED", "COMBINATION" and "bearer token" are what the *stored
 * configuration* calls things. A person creating their first mock API is
 * answering "does someone need to log in to use this?" — so the questions are
 * phrased that way and the vocabulary is introduced alongside, not assumed.
 */

import type { AuthConfigView, AuthMode, EntityAuth } from './api-types';
import { DEFAULT_ACCESS_TTL, DEFAULT_REFRESH_TTL } from './auth-config';

export interface AuthChoice {
  mode: AuthMode;
  /** The answer, as a person would say it. */
  label: string;
  /** One sentence of consequence, not of definition. */
  description: string;
}

/**
 * §1's question for a Single API.
 *
 * Two options, and `COMBINATION` is deliberately absent: a Single API is one
 * resource, so "per entity" has nothing to choose between and offering it would
 * be a menu item that does nothing.
 */
export const SIMPLE_CHOICES: readonly AuthChoice[] = [
  {
    mode: 'NONE',
    label: 'No — anyone with the URL can use it',
    description:
      'Good for prototypes and public data. You can add sign-in later without starting over.',
  },
  {
    mode: 'ALL_PROTECTED',
    label: 'Yes — callers must sign in first',
    description:
      'Adds sign-up and sign-in endpoints. Every other request needs the token they return.',
  },
];

/** §2's question for a Project API, where "some of them" is the common answer. */
export const PROJECT_CHOICES: readonly AuthChoice[] = [
  {
    mode: 'NONE',
    label: 'No — everything is open',
    description:
      'Good for prototypes and public data. You can add sign-in later without starting over.',
  },
  {
    mode: 'ALL_PROTECTED',
    label: 'Yes — everything needs a login',
    description:
      'Adds sign-up and sign-in endpoints. Every other request needs the token they return.',
  },
  {
    mode: 'COMBINATION',
    label: 'Some of it — I will choose which',
    description:
      'Pick the entities that need a login. The rest stay open, so a product catalogue can be public while orders are not.',
  },
];

/**
 * The configuration a wizard answer produces.
 *
 * `NONE` returns null rather than `{ mode: 'NONE' }`, and the whole chain
 * respects that: a project created by someone who declined has no
 * `authentication` block at all — byte-identical to a project created before
 * Phase 3 existed. Storing an explicit off-switch would make the first version's
 * diff report a setting nobody chose.
 */
export function configForChoice(mode: AuthMode): AuthConfigView | null {
  if (mode === 'NONE') {
    return null;
  }
  return {
    mode,
    signup: true,
    signin: true,
    refreshToken: true,
    // Off by default: cookie mode changes the sign-in response shape and needs
    // CORS thought about, which is not a first-run decision. The Auth tab
    // offers it once the user has something working.
    cookieAuth: false,
    accessTokenExpiresIn: DEFAULT_ACCESS_TTL,
    refreshTokenExpiresIn: DEFAULT_REFRESH_TTL,
    userFields: [],
  };
}

/**
 * Stamp the wizard's per-entity answers, for `COMBINATION`.
 *
 * Anything the user did not tick is public. That is the safe default *here*,
 * unlike the runtime's fail-closed fallback, and the difference is deliberate:
 * this list is the user's own answer to a question they were just asked, so an
 * unticked box means "no". The runtime's fallback covers a document that lost a
 * field, where there is no answer to honour.
 */
export function stampChoices(
  entities: readonly { name: string }[],
  protectedNames: readonly string[],
): { name: string; authentication: EntityAuth }[] {
  return entities.map((entity) => ({
    name: entity.name,
    authentication: protectedNames.includes(entity.name) ? 'PROTECTED' : 'PUBLIC',
  }));
}

export interface EndpointPreview {
  method: string;
  path: string;
  /** Whether this endpoint will need a token. */
  requiresAuth: boolean;
  /** True for the generated Auth API's own endpoints. */
  isAuthApi: boolean;
}

/**
 * What the user will get — the answer to "show me the proper endpoints".
 *
 * This is the part that does the teaching. A radio button labelled "everything
 * needs a login" is an abstraction; a list showing `GET /orders 🔒` next to
 * `POST /signIn` is the thing itself, and it is what makes the next screen
 * unsurprising.
 *
 * Auth endpoints first, because they are the new thing and they are what a
 * caller has to use before any of the rest works.
 */
export function previewEndpoints(params: {
  mode: AuthMode;
  entities: readonly { name: string }[];
  protectedNames: readonly string[];
  methods: readonly string[];
  signup: boolean;
  refreshToken: boolean;
}): EndpointPreview[] {
  const preview: EndpointPreview[] = [];
  const authOn = params.mode !== 'NONE';

  if (authOn) {
    if (params.signup) {
      preview.push({ method: 'POST', path: '/signUp', requiresAuth: false, isAuthApi: true });
    }
    preview.push({ method: 'POST', path: '/signIn', requiresAuth: false, isAuthApi: true });
    if (params.refreshToken) {
      preview.push({ method: 'POST', path: '/refresh', requiresAuth: false, isAuthApi: true });
    }
    preview.push({ method: 'GET', path: '/me', requiresAuth: true, isAuthApi: true });
    preview.push({ method: 'POST', path: '/logout', requiresAuth: false, isAuthApi: true });
  }

  for (const entity of params.entities) {
    const slug = entity.name.toLowerCase();
    const requiresAuth =
      params.mode === 'ALL_PROTECTED' ||
      (params.mode === 'COMBINATION' && params.protectedNames.includes(entity.name));

    for (const method of params.methods) {
      // The record-shaped methods address one record; the collection-shaped ones
      // address the set. Mirrors what the runtime actually routes, so the
      // preview is not a prettier version of a different API.
      const path = method === 'GET' || method === 'POST' ? `/${slug}` : `/${slug}/{id}`;
      preview.push({ method, path, requiresAuth, isAuthApi: false });
    }
  }

  return preview;
}

/**
 * One line summarising the answer, for the wizard's review step.
 *
 * States what a caller must do, because that is the consequence the user is
 * choosing between — not which mode name got stored.
 */
export function describeChoice(mode: AuthMode, protectedCount: number, total: number): string {
  switch (mode) {
    case 'NONE':
      return 'No authentication — every endpoint is open.';
    case 'ALL_PUBLIC':
      return 'Sign-in exists, but no endpoint requires it.';
    case 'ALL_PROTECTED':
      return 'Every endpoint requires a signed-in caller.';
    case 'COMBINATION':
      if (protectedCount === 0) {
        return 'Sign-in exists, but you have not marked any entity as needing it yet.';
      }
      return `${protectedCount} of ${total} ${total === 1 ? 'entity' : 'entities'} require a signed-in caller.`;
  }
}

/**
 * A caveat when `COMBINATION` was chosen and nothing was ticked.
 *
 * Not an error — it is a valid configuration and the user may intend to decide
 * later on the Auth tab. But it is almost certainly not what they meant one
 * click after choosing "some of it", so it is worth saying before they generate
 * rather than leaving them to notice an open API.
 */
export function emptySelectionWarning(mode: AuthMode, protectedCount: number): string | null {
  if (mode !== 'COMBINATION' || protectedCount > 0) {
    return null;
  }
  return 'You chose to protect some entities but have not selected any, so everything will be open. Tick the ones that need a login, or choose one of the other options.';
}

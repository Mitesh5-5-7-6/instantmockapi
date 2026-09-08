/**
 * Reading authentication configuration (Phase 3 §3, §15, §26).
 *
 * ## This is not the platform's auth
 *
 * `packages/auth` signs in **project owners** — the people who use
 * InstantMockAPI. Everything here describes authentication on the **generated
 * mock API**, for the developer's own end users. The two share all five endpoint
 * names (`signUp`, `signIn`, `refresh`, `me`, `logout`) and no code, and a token
 * minted for a hosted mock API must never authenticate against the platform.
 * Reusing `packages/auth/tokens.ts` here would make signing up to somebody's
 * mock todo API a route to a project-owner session.
 *
 * ## Everything is read through a helper
 *
 * The same discipline `entityRelations` and `queryFeatures` already follow, and
 * for a sharper reason: whether an entity is protected is **not** a property of
 * the entity alone. It depends on the project's mode, so
 * `entity.authentication` read raw gets `ALL_PROTECTED` and `NONE` projects
 * wrong — in the direction that exposes data.
 *
 * §26 is the other half: a project written before Phase 3 has no
 * `authentication` block at all, and must behave exactly as it did. An absent
 * block resolves to `NONE`, which is why nothing here may return `undefined`.
 */

import type {
  AuthConfig,
  AuthMode,
  AuthUserField,
  Entity,
  EntityAuth,
  InternalProjectSchema,
} from './types.js';

/** §7 and §8's defaults, in one place so the runtime and the wizard agree. */
export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '7d';

export const AUTH_MODES: readonly AuthMode[] = [
  'NONE',
  'ALL_PUBLIC',
  'ALL_PROTECTED',
  'COMBINATION',
];

/**
 * What a project with no `authentication` block means.
 *
 * Not merely "all public": the Auth API does not exist either, so there is
 * nothing to sign in to. That is what makes §26 hold — a pre-Phase-3 project
 * resolves to this and its generated API is byte-identical to before.
 */
export const NO_AUTH: AuthConfig = {
  mode: 'NONE',
  signup: false,
  signin: false,
  refreshToken: false,
  cookieAuth: false,
  accessTokenExpiresIn: DEFAULT_ACCESS_TOKEN_TTL,
  refreshTokenExpiresIn: DEFAULT_REFRESH_TOKEN_TTL,
  userFields: [],
};

/**
 * The Auth API's endpoint names, lowercased (Phase 3 §4).
 *
 * Defined here rather than in the runtime because two consumers need the exact
 * same list and would otherwise drift: the runtime routes on it, and
 * `validateIPS` reserves entity names against it. A name added to one and not
 * the other is either an endpoint no validation protects or a name reserved for
 * nothing.
 *
 * Lowercased because `entitySlug` lowercases, so `/signUp` and `/signup` must
 * be treated as the same name — otherwise an entity called `Signup` claims a
 * URL one capital letter away from the Auth API's.
 */
export const AUTH_ENDPOINT_NAMES = ['signup', 'signin', 'refresh', 'me', 'logout'] as const;

export type AuthEndpointName = (typeof AUTH_ENDPOINT_NAMES)[number];

/** Set form, for the validator's reservation check and the runtime's router. */
export const RESERVED_ENTITY_NAMES: ReadonlySet<string> = new Set(AUTH_ENDPOINT_NAMES);

function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === 'string' && (AUTH_MODES as readonly string[]).includes(value);
}

/**
 * Normalise one custom signup field, or drop it.
 *
 * Dropping rather than throwing: this runs over historical documents and over
 * whatever a client PATCHed before validation tightened, and a malformed entry
 * must not be able to take down a comparison of two old versions. The validator
 * is where a bad field becomes an error the author sees.
 */
function readUserField(value: unknown): AuthUserField | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['name'] !== 'string' || raw['name'] === '') {
    return null;
  }
  const type = raw['type'];
  return {
    name: raw['name'],
    type: type === 'number' || type === 'boolean' ? type : 'string',
    required: raw['required'] === true,
  };
}

/**
 * The project's authentication configuration — never undefined, never partial.
 *
 * Takes the whole IPS rather than the block so callers cannot accidentally pass
 * a raw `ips.authentication` and get the `undefined` this exists to absorb.
 */
export function projectAuth(
  ips: Pick<InternalProjectSchema, 'authentication'> | null | undefined,
): AuthConfig {
  const raw = ips?.authentication;
  if (typeof raw !== 'object' || raw === null) {
    return NO_AUTH;
  }
  const block = raw as unknown as Record<string, unknown>;
  const mode = isAuthMode(block['mode']) ? block['mode'] : 'NONE';

  // A mode of NONE means no Auth API, whatever the individual toggles say — a
  // half-written document must not produce a signin endpoint on a project whose
  // author never enabled authentication.
  if (mode === 'NONE') {
    return NO_AUTH;
  }

  return {
    mode,
    // Signup and signin default ON for any enabled mode: a project with
    // authentication and no way to obtain a token is not a configuration
    // anybody chose, it is a document that lost a field.
    signup: block['signup'] !== false,
    signin: block['signin'] !== false,
    refreshToken: block['refreshToken'] !== false,
    cookieAuth: block['cookieAuth'] === true,
    accessTokenExpiresIn:
      typeof block['accessTokenExpiresIn'] === 'string' && block['accessTokenExpiresIn'] !== ''
        ? block['accessTokenExpiresIn']
        : DEFAULT_ACCESS_TOKEN_TTL,
    refreshTokenExpiresIn:
      typeof block['refreshTokenExpiresIn'] === 'string' && block['refreshTokenExpiresIn'] !== ''
        ? block['refreshTokenExpiresIn']
        : DEFAULT_REFRESH_TOKEN_TTL,
    userFields: Array.isArray(block['userFields'])
      ? block['userFields']
          .map(readUserField)
          .filter((field): field is AuthUserField => field !== null)
      : [],
  };
}

/** True when the Auth API exists at all — the gate on generating those endpoints. */
export function authEnabled(config: AuthConfig): boolean {
  return config.mode !== 'NONE';
}

/**
 * Whether one entity's endpoints require a token.
 *
 * The mode decides for three of the four values; only `COMBINATION` consults
 * the entity. That ordering is the point — an entity carrying a stale
 * `authentication: 'PUBLIC'` from a previous stint in combination mode must not
 * punch a hole through `ALL_PROTECTED`.
 *
 * ## The COMBINATION fallback is PROTECTED
 *
 * An entity in combination mode with no explicit setting is a document that
 * lost a field, since `stampEntityAuth` writes one for every entity when the
 * mode is set. Failing closed is the only safe default: guessing `PUBLIC` would
 * expose an endpoint the author never marked public, and it would do so
 * silently. The cost of guessing wrong the other way is a 401 the author can
 * see and fix.
 */
export function entityAuth(config: AuthConfig, entity: Pick<Entity, 'authentication'>): EntityAuth {
  switch (config.mode) {
    case 'NONE':
    case 'ALL_PUBLIC':
      return 'PUBLIC';
    case 'ALL_PROTECTED':
      return 'PROTECTED';
    case 'COMBINATION':
      return entity.authentication === 'PUBLIC' ? 'PUBLIC' : 'PROTECTED';
  }
}

/** Entities whose endpoints require a token, in declaration order. */
export function protectedEntities(ips: InternalProjectSchema): Entity[] {
  const config = projectAuth(ips);
  return (ips.entities ?? []).filter((entity) => entityAuth(config, entity) === 'PROTECTED');
}

/**
 * Write each entity's *current effective* protection explicitly.
 *
 * Called when the mode changes, and the reason is a surprise this prevents:
 * switching `ALL_PUBLIC → COMBINATION` with no stamping would hand every entity
 * to `entityAuth`'s fail-closed fallback and take the whole API dark in one
 * click — a breaking change the user did not ask for and the diff would report
 * as twelve separate `ENTITY_AUTH_CHANGED` rows.
 *
 * Stamping under the *outgoing* mode preserves what was true, so the mode
 * change itself is the only change, and the user then flips the handful of
 * entities they actually meant to.
 *
 * Mutates in place and returns the same object, matching `materializeRelations`
 * and `ensureSchemaIds`. Callers that must not mutate history deep-clone first.
 */
export function stampEntityAuth(
  ips: InternalProjectSchema,
  nextMode: AuthMode,
): InternalProjectSchema {
  const outgoing = projectAuth(ips);

  for (const entity of ips.entities ?? []) {
    if (nextMode === 'COMBINATION') {
      entity.authentication = entityAuth(outgoing, entity);
    } else {
      // Outside combination mode the field cannot be consulted, and leaving a
      // stale value behind is how it later contradicts the mode that is
      // actually in force.
      delete entity.authentication;
    }
  }

  ips.authentication = { ...outgoing, mode: nextMode };
  return ips;
}

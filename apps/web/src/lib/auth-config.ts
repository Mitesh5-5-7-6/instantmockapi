/**
 * The Auth tab's rules (Phase 3 §1–§3, §15, §25).
 *
 * Pure, because `apps/web` runs vitest with `environment: 'node'` — a rule that
 * lives inside a component cannot be tested at all. The page is a render of
 * what is here.
 *
 * ## This mirrors `packages/ips/src/auth.ts` and must not diverge
 *
 * The client cannot import that module (`web-must-not-import-server`), so the
 * resolution rule is restated. `authConfigRules.test.ts` pins the same 4×3
 * matrix `auth-invariants.test.ts` pins on the server, for exactly that reason:
 * two copies of a rule stay honest only while something compares them.
 *
 * The stakes are the same as on the server, and the mistake looks just as
 * reasonable: reading `entity.authentication` directly is right in
 * `COMBINATION` and silently wrong in `ALL_PROTECTED`, where the field is
 * absent by design — so the UI would show every entity as public on a project
 * where every entity is closed.
 */

import type { AuthConfigView, AuthMode, EntityAuth, IpsAuthShape } from './api-types';

export const AUTH_MODES: readonly AuthMode[] = [
  'NONE',
  'ALL_PUBLIC',
  'ALL_PROTECTED',
  'COMBINATION',
];

/** §7/§8's defaults, matching the server's. */
export const DEFAULT_ACCESS_TTL = '15m';
export const DEFAULT_REFRESH_TTL = '7d';

export const NO_AUTH: AuthConfigView = {
  mode: 'NONE',
  signup: false,
  signin: false,
  refreshToken: false,
  cookieAuth: false,
  accessTokenExpiresIn: DEFAULT_ACCESS_TTL,
  refreshTokenExpiresIn: DEFAULT_REFRESH_TTL,
  userFields: [],
};

/**
 * What each mode means, in the words the tab shows.
 *
 * `NONE` and `ALL_PUBLIC` both leave the business endpoints open, and the copy
 * has to make the difference legible or the choice looks like a duplicate: only
 * one of them generates an Auth API at all.
 */
export const MODE_LABEL: Record<AuthMode, string> = {
  NONE: 'No authentication',
  ALL_PUBLIC: 'All public',
  ALL_PROTECTED: 'All protected',
  COMBINATION: 'Per entity',
};

export const MODE_DESCRIPTION: Record<AuthMode, string> = {
  NONE: 'No Auth API is generated. Every endpoint is open — the API behaves exactly as it does today.',
  ALL_PUBLIC:
    'Sign-up and sign-in exist, but no endpoint requires a token. Useful when you want the auth flow without gating anything yet.',
  ALL_PROTECTED: 'Every endpoint requires an access token. Callers must sign in first.',
  COMBINATION: 'You choose per entity. All methods of an entity share its setting.',
};

/** The config, never undefined and never partial (§26). */
export function authConfigOf(ips: IpsAuthShape | null | undefined): AuthConfigView {
  const raw = ips?.authentication;
  if (raw === undefined || raw === null || !AUTH_MODES.includes(raw.mode)) {
    return NO_AUTH;
  }
  if (raw.mode === 'NONE') {
    // A mode of NONE means no Auth API whatever the other flags say, matching
    // `projectAuth` on the server.
    return NO_AUTH;
  }
  return {
    ...raw,
    userFields: Array.isArray(raw.userFields) ? raw.userFields : [],
  };
}

export function authEnabled(config: AuthConfigView): boolean {
  return config.mode !== 'NONE';
}

/**
 * Whether an entity's endpoints require a token.
 *
 * The mode decides for three of the four values; only `COMBINATION` consults
 * the entity, and an unstamped entity there resolves to `PROTECTED` — failing
 * closed, exactly as the server does. Showing "public" for an entity the API
 * actually closes would be the worse error: the user would not go looking.
 */
export function entityAuthOf(
  config: AuthConfigView,
  entity: { authentication?: EntityAuth },
): EntityAuth {
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

export interface EntityAuthRow {
  name: string;
  auth: EntityAuth;
  /** False outside COMBINATION, where the mode decides and the control is inert. */
  editable: boolean;
}

/** One row per entity, for §3's list. */
export function entityAuthRows(ips: IpsAuthShape | null | undefined): EntityAuthRow[] {
  const config = authConfigOf(ips);
  const editable = config.mode === 'COMBINATION';
  return (ips?.entities ?? []).map((entity) => ({
    name: entity.name,
    auth: entityAuthOf(config, entity),
    editable,
  }));
}

/**
 * The mode change, with the entities stamped — the client's half of §3.
 *
 * The server does this too (`stampAuthModeChange`), and doing it here as well
 * is not redundant: without it the tab would show every entity as protected the
 * instant the user picked `Per entity`, then show something different after the
 * save came back. The user would watch their API appear to go dark and then
 * un-dark, which is worse than either state.
 *
 * Stamped under the mode being **left**, which is what preserves what was true.
 */
export function applyMode(ips: IpsAuthShape, nextMode: AuthMode): IpsAuthShape {
  const outgoing = authConfigOf(ips);
  const entities = ips.entities.map((entity) =>
    nextMode === 'COMBINATION'
      ? { ...entity, authentication: entityAuthOf(outgoing, entity) }
      : withoutAuth(entity),
  );

  if (nextMode === 'NONE') {
    // Turning authentication off drops the block entirely rather than storing
    // `mode: 'NONE'` beside stale settings — the same shape a project that
    // never had authentication carries, so the diff reports going back to
    // no-auth as one change rather than several.
    const { authentication: _dropped, ...rest } = ips;
    return { ...rest, entities };
  }

  return {
    ...ips,
    entities,
    authentication: {
      // Every setting other than the mode is preserved, so changing the mode
      // does not quietly revert a cookie or lifetime the user just set.
      ...(authEnabled(outgoing)
        ? outgoing
        : { ...NO_AUTH, signup: true, signin: true, refreshToken: true }),
      mode: nextMode,
    },
  };
}

function withoutAuth<T extends { authentication?: EntityAuth }>(entity: T): T {
  const { authentication: _stale, ...rest } = entity;
  return rest as T;
}

/** Flip one entity, which is only meaningful in COMBINATION mode. */
export function setEntityAuth(ips: IpsAuthShape, name: string, auth: EntityAuth): IpsAuthShape {
  return {
    ...ips,
    entities: ips.entities.map((entity) =>
      entity.name === name ? { ...entity, authentication: auth } : entity,
    ),
  };
}

/** Merge a settings change into the config, leaving the mode alone. */
export function updateAuthSettings(
  ips: IpsAuthShape,
  patch: Partial<Omit<AuthConfigView, 'mode'>>,
): IpsAuthShape {
  const current = authConfigOf(ips);
  if (!authEnabled(current)) {
    // Nothing to configure on a project with no Auth API, and writing a block
    // here would turn authentication on as a side effect of a checkbox.
    return ips;
  }
  return { ...ips, authentication: { ...current, ...patch } };
}

/* ────────────────────────── validation ────────────────────────── */

/** `15m`, `7d`, `900s` — the grammar the server enforces. */
const DURATION = /^[1-9][0-9]*(s|m|h|d)$/;

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Names the auth user already owns.
 *
 * The server rejects these outright (§23): a custom field called
 * `passwordHash` would be written from the signup body and echoed back as
 * ordinary user data, defeating "never expose the hash" without any code
 * violating it. Checked here so the user finds out while typing rather than on
 * save.
 */
export const RESERVED_USER_FIELDS: readonly string[] = [
  'id',
  'email',
  'password',
  'passwordHash',
  'createdAt',
  'updatedAt',
];

/** Entity names the Auth API's own endpoints occupy, once it exists. */
export const RESERVED_ENTITY_NAMES: readonly string[] = [
  'signup',
  'signin',
  'refresh',
  'me',
  'logout',
];

export interface AuthProblem {
  /** Which control to attach the message to. */
  field: string;
  message: string;
}

/**
 * Everything wrong with the current configuration, for inline display.
 *
 * Mirrors `validateAuth` and the reserved-name check on the server. The server
 * remains the authority — this exists so the user is not told "422" for
 * something a field-level message could have explained.
 */
export function authProblems(ips: IpsAuthShape | null | undefined): AuthProblem[] {
  const config = authConfigOf(ips);
  const problems: AuthProblem[] = [];
  if (!authEnabled(config)) {
    return problems;
  }

  if (!DURATION.test(config.accessTokenExpiresIn)) {
    problems.push({
      field: 'accessTokenExpiresIn',
      message: 'Use a duration such as 15m, 24h or 7d.',
    });
  }
  if (!DURATION.test(config.refreshTokenExpiresIn)) {
    problems.push({
      field: 'refreshTokenExpiresIn',
      message: 'Use a duration such as 15m, 24h or 7d.',
    });
  }

  // A project that requires authentication with no way to obtain a token is a
  // locked door with no key: every endpoint 401s and nothing can ever sign in.
  if (!config.signin) {
    problems.push({
      field: 'signin',
      message: 'Sign-in cannot be off while authentication is on — nothing could obtain a token.',
    });
  }

  const seen = new Set<string>();
  config.userFields.forEach((field, index) => {
    if (!IDENTIFIER.test(field.name)) {
      problems.push({
        field: `userFields.${index}.name`,
        message: 'Use letters, digits and underscores.',
      });
      return;
    }
    if (RESERVED_USER_FIELDS.includes(field.name)) {
      problems.push({
        field: `userFields.${index}.name`,
        message: `'${field.name}' is reserved on the auth user.`,
      });
    }
    if (seen.has(field.name)) {
      problems.push({ field: `userFields.${index}.name`, message: 'Duplicate field name.' });
    }
    seen.add(field.name);
  });

  for (const entity of ips?.entities ?? []) {
    if (RESERVED_ENTITY_NAMES.includes(entity.name.toLowerCase())) {
      problems.push({
        field: 'entities',
        message: `The entity '${entity.name}' collides with the Auth API endpoint /${entity.name.toLowerCase()}. Rename it, or turn authentication off.`,
      });
    }
  }

  return problems;
}

/**
 * A one-line summary of what callers must now do, for the tab header.
 *
 * Says the consequence rather than the setting: "3 of 5 endpoints need a token"
 * is what a developer is actually trying to find out.
 */
export function authSummary(ips: IpsAuthShape | null | undefined): string {
  const config = authConfigOf(ips);
  if (!authEnabled(config)) {
    return 'No authentication. Every endpoint is open.';
  }
  const rows = entityAuthRows(ips);
  const closed = rows.filter((row) => row.auth === 'PROTECTED').length;

  if (rows.length === 0) {
    return 'Auth API generated. No entities yet.';
  }
  if (closed === 0) {
    return `Auth API generated. All ${rows.length} ${rows.length === 1 ? 'entity is' : 'entities are'} public.`;
  }
  if (closed === rows.length) {
    return `Every entity requires an access token.`;
  }
  return `${closed} of ${rows.length} entities require an access token.`;
}

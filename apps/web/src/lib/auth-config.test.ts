import { describe, it, expect } from 'vitest';

import type { AuthConfigView, AuthMode, EntityAuth, IpsAuthShape } from './api-types';
import {
  NO_AUTH,
  applyMode,
  authConfigOf,
  authEnabled,
  authProblems,
  authSummary,
  entityAuthOf,
  entityAuthRows,
  setEntityAuth,
  updateAuthSettings,
} from './auth-config';

/**
 * The client's copy of the resolution rule.
 *
 * The 4×3 matrix below is deliberately the same one `auth-invariants.test.ts`
 * pins on the server. The client cannot import that module, so the rule is
 * restated — and two copies of a rule stay honest only while something compares
 * them. If the server's table ever changes, this file is what fails.
 */

const config = (mode: AuthMode, over: Partial<AuthConfigView> = {}): AuthConfigView => ({
  ...NO_AUTH,
  mode,
  signup: mode !== 'NONE',
  signin: mode !== 'NONE',
  refreshToken: mode !== 'NONE',
  ...over,
});

const ips = (mode: AuthMode | null, stamps: Record<string, EntityAuth> = {}): IpsAuthShape => ({
  entities: [
    {
      id: 'ent_p',
      name: 'Product',
      ...(stamps['Product'] ? { authentication: stamps['Product'] } : {}),
    },
    { id: 'ent_o', name: 'Order', ...(stamps['Order'] ? { authentication: stamps['Order'] } : {}) },
  ],
  ...(mode === null ? {} : { authentication: config(mode) }),
});

const STAMPS: readonly (EntityAuth | undefined)[] = ['PUBLIC', 'PROTECTED', undefined];
const key = (stamp: EntityAuth | undefined) => stamp ?? ('absent' as const);

/** The same table the server pins. */
const EXPECTED: Record<AuthMode, Record<'PUBLIC' | 'PROTECTED' | 'absent', EntityAuth>> = {
  NONE: { PUBLIC: 'PUBLIC', PROTECTED: 'PUBLIC', absent: 'PUBLIC' },
  ALL_PUBLIC: { PUBLIC: 'PUBLIC', PROTECTED: 'PUBLIC', absent: 'PUBLIC' },
  ALL_PROTECTED: { PUBLIC: 'PROTECTED', PROTECTED: 'PROTECTED', absent: 'PROTECTED' },
  COMBINATION: { PUBLIC: 'PUBLIC', PROTECTED: 'PROTECTED', absent: 'PROTECTED' },
};

describe('the resolution matrix matches the server', () => {
  for (const mode of ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED', 'COMBINATION'] as const) {
    for (const stamp of STAMPS) {
      it(`${mode} with a ${key(stamp)} stamp resolves to ${EXPECTED[mode][key(stamp)]}`, () => {
        const entity = stamp === undefined ? {} : { authentication: stamp };
        expect(entityAuthOf(config(mode), entity)).toBe(EXPECTED[mode][key(stamp)]);
      });
    }
  }

  /**
   * The mistake this exists to prevent: reading the field directly shows every
   * entity as public on an `ALL_PROTECTED` project, because the field is absent
   * by design there. The user would not go looking for a problem the UI told
   * them they did not have.
   */
  it('shows an ALL_PROTECTED entity as protected despite a stale PUBLIC stamp', () => {
    expect(entityAuthOf(config('ALL_PROTECTED'), { authentication: 'PUBLIC' })).toBe('PROTECTED');
  });
});

describe('§26: a project with no authentication', () => {
  it('resolves to NONE rather than undefined', () => {
    expect(authConfigOf(ips(null))).toEqual(NO_AUTH);
    expect(authConfigOf(null)).toEqual(NO_AUTH);
    expect(authEnabled(authConfigOf(ips(null)))).toBe(false);
  });

  it('reports every entity public and raises no problems', () => {
    expect(entityAuthRows(ips(null)).every((row) => row.auth === 'PUBLIC')).toBe(true);
    expect(authProblems(ips(null))).toEqual([]);
  });

  it('says so plainly in the summary', () => {
    expect(authSummary(ips(null))).toContain('No authentication');
  });
});

describe('entityAuthRows', () => {
  it('is editable only in COMBINATION mode', () => {
    expect(entityAuthRows(ips('COMBINATION')).every((row) => row.editable)).toBe(true);
    for (const mode of ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED'] as const) {
      expect(
        entityAuthRows(ips(mode)).every((row) => !row.editable),
        mode,
      ).toBe(true);
    }
  });

  it('reports the resolved value, not the stored one', () => {
    const rows = entityAuthRows(ips('ALL_PROTECTED', { Product: 'PUBLIC' }));
    expect(rows.every((row) => row.auth === 'PROTECTED')).toBe(true);
  });
});

describe('applyMode', () => {
  /**
   * The reason the client stamps too, rather than waiting for the server.
   *
   * Without it the tab would show every entity as protected the instant the
   * user picked `Per entity`, then show something different once the save
   * returned — the user would watch their API appear to go dark and then
   * un-dark.
   */
  it('preserves public entities entering COMBINATION from ALL_PUBLIC', () => {
    const next = applyMode(ips('ALL_PUBLIC'), 'COMBINATION');
    expect(next.entities.every((entity) => entity.authentication === 'PUBLIC')).toBe(true);
    expect(entityAuthRows(next).every((row) => row.auth === 'PUBLIC')).toBe(true);
  });

  it('preserves protected entities entering COMBINATION from ALL_PROTECTED', () => {
    const next = applyMode(ips('ALL_PROTECTED'), 'COMBINATION');
    expect(next.entities.every((entity) => entity.authentication === 'PROTECTED')).toBe(true);
  });

  it('starts open when turning authentication on from nothing', () => {
    const next = applyMode(ips(null), 'COMBINATION');
    expect(next.entities.every((entity) => entity.authentication === 'PUBLIC')).toBe(true);
    expect(authConfigOf(next).signin).toBe(true);
  });

  it('clears the stamps leaving COMBINATION', () => {
    const next = applyMode(
      ips('COMBINATION', { Product: 'PUBLIC', Order: 'PROTECTED' }),
      'ALL_PROTECTED',
    );
    expect(next.entities.every((entity) => entity.authentication === undefined)).toBe(true);
  });

  it('keeps every other setting across a mode change', () => {
    const start = updateAuthSettings(ips('ALL_PUBLIC'), {
      cookieAuth: true,
      accessTokenExpiresIn: '5m',
      userFields: [{ name: 'displayName', type: 'string', required: true }],
    });
    const next = applyMode(start, 'COMBINATION');
    const resolved = authConfigOf(next);

    expect(resolved.mode).toBe('COMBINATION');
    expect(resolved.cookieAuth).toBe(true);
    expect(resolved.accessTokenExpiresIn).toBe('5m');
    expect(resolved.userFields).toHaveLength(1);
  });

  /**
   * Turning authentication off drops the block rather than storing
   * `mode: 'NONE'` beside stale settings — the same shape a project that never
   * had authentication carries, so the diff reports one change rather than
   * several.
   */
  it('drops the block entirely when set to NONE', () => {
    const next = applyMode(ips('COMBINATION', { Product: 'PUBLIC' }), 'NONE');
    expect(next.authentication).toBeUndefined();
    expect(next.entities.every((entity) => entity.authentication === undefined)).toBe(true);
  });
});

describe('setEntityAuth and updateAuthSettings', () => {
  it('flips one entity and leaves its neighbour alone', () => {
    const next = setEntityAuth(
      ips('COMBINATION', { Product: 'PUBLIC', Order: 'PUBLIC' }),
      'Order',
      'PROTECTED',
    );
    const rows = entityAuthRows(next);
    expect(rows.find((row) => row.name === 'Order')!.auth).toBe('PROTECTED');
    expect(rows.find((row) => row.name === 'Product')!.auth).toBe('PUBLIC');
  });

  it('refuses to write settings onto a project with no Auth API', () => {
    // Otherwise a checkbox would turn authentication on as a side effect.
    const next = updateAuthSettings(ips(null), { cookieAuth: true });
    expect(next.authentication).toBeUndefined();
  });

  it('never changes the mode', () => {
    const next = updateAuthSettings(ips('ALL_PUBLIC'), { cookieAuth: true });
    expect(authConfigOf(next).mode).toBe('ALL_PUBLIC');
  });
});

describe('authProblems', () => {
  const withConfig = (over: Partial<AuthConfigView>) =>
    authProblems(updateAuthSettings(ips('ALL_PROTECTED'), over));

  it('is silent on a valid configuration', () => {
    expect(authProblems(ips('ALL_PROTECTED'))).toEqual([]);
  });

  it('rejects a malformed duration, naming the field', () => {
    const problems = withConfig({ accessTokenExpiresIn: '900' });
    expect(problems.map((problem) => problem.field)).toContain('accessTokenExpiresIn');
  });

  it('refuses a locked door with no key', () => {
    const problems = withConfig({ signin: false });
    expect(problems.map((problem) => problem.field)).toContain('signin');
  });

  it('allows signup to be off, which is a real configuration', () => {
    // An invite-only API: accounts exist, but not through a public endpoint.
    expect(withConfig({ signup: false })).toEqual([]);
  });

  /**
   * §23's reserved names. A custom field called `passwordHash` would be written
   * from the signup body and echoed back as ordinary user data.
   */
  it('rejects a custom field that shadows a reserved one', () => {
    for (const name of ['passwordHash', 'password', 'email', 'id']) {
      const problems = withConfig({ userFields: [{ name, type: 'string', required: false }] });
      expect(problems.length, name).toBeGreaterThan(0);
    }
  });

  it('rejects a duplicate and a non-identifier field name', () => {
    expect(
      withConfig({
        userFields: [
          { name: 'nick', type: 'string', required: false },
          { name: 'nick', type: 'number', required: false },
        ],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      withConfig({ userFields: [{ name: 'first name', type: 'string', required: false }] }).length,
    ).toBeGreaterThan(0);
  });

  /**
   * The collision the server rejects at save time. Surfacing it here means the
   * user reads a sentence naming the entity instead of a 422.
   */
  it('names an entity that collides with an auth endpoint', () => {
    const colliding: IpsAuthShape = {
      entities: [{ name: 'Me' }],
      authentication: config('ALL_PROTECTED'),
    };
    const problems = authProblems(colliding);
    expect(problems.map((problem) => problem.field)).toContain('entities');
    expect(problems[0]!.message).toContain('/me');
  });

  it('says nothing about that entity while authentication is off', () => {
    // §26: an existing project with a `Me` entity keeps working untouched.
    expect(authProblems({ entities: [{ name: 'Me' }] })).toEqual([]);
  });
});

describe('authSummary', () => {
  it('states the consequence rather than the setting', () => {
    expect(authSummary(ips('ALL_PROTECTED'))).toContain('requires an access token');
    expect(authSummary(ips('ALL_PUBLIC'))).toContain('public');
  });

  it('counts the protected entities in COMBINATION mode', () => {
    const mixed = ips('COMBINATION', { Product: 'PUBLIC', Order: 'PROTECTED' });
    expect(authSummary(mixed)).toBe('1 of 2 entities require an access token.');
  });

  it('does not claim a count for a project with no entities', () => {
    expect(authSummary({ entities: [], authentication: config('ALL_PROTECTED') })).toContain(
      'No entities yet',
    );
  });
});

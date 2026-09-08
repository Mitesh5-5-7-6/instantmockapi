import { describe, it, expect } from 'vitest';

import {
  NO_AUTH,
  authEnabled,
  entityAuth,
  projectAuth,
  protectedEntities,
  stampEntityAuth,
} from './auth.js';
import type { AuthConfig, AuthMode, Entity, InternalProjectSchema } from './types.js';

const entity = (name: string, authentication?: 'PUBLIC' | 'PROTECTED'): Entity => ({
  name,
  fields: [],
  ...(authentication === undefined ? {} : { authentication }),
});

const ips = (over: Partial<InternalProjectSchema> = {}): InternalProjectSchema => ({
  projectId: 'p1',
  version: 1,
  entities: [entity('Product'), entity('Payment')],
  generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 5 },
  ...over,
});

const config = (mode: AuthMode, over: Partial<AuthConfig> = {}): AuthConfig => ({
  ...NO_AUTH,
  mode,
  signup: true,
  signin: true,
  refreshToken: true,
  ...over,
});

describe('§26: a project written before Phase 3', () => {
  /**
   * The compatibility rule, and the reason nothing here may return
   * `undefined`: an absent block has to resolve to a real configuration, or
   * every consumer needs its own fallback and they will disagree.
   */
  it('resolves to NONE rather than to undefined', () => {
    expect(projectAuth(ips()).mode).toBe('NONE');
    expect(projectAuth(undefined).mode).toBe('NONE');
    expect(projectAuth(null).mode).toBe('NONE');
  });

  it('has no Auth API, which is not the same as having public endpoints', () => {
    // `NONE` and `ALL_PUBLIC` both leave the business endpoints open, but only
    // one of them generates somewhere to sign in. Collapsing the two would put
    // /signUp on every legacy project.
    const none = projectAuth(ips());
    expect(authEnabled(none)).toBe(false);
    expect(none.signup).toBe(false);
    expect(none.signin).toBe(false);

    expect(authEnabled(config('ALL_PUBLIC'))).toBe(true);
  });

  it('leaves every entity public', () => {
    expect(protectedEntities(ips())).toEqual([]);
  });
});

describe('projectAuth normalises a partial document', () => {
  it('fills the §7/§8 default lifetimes', () => {
    const resolved = projectAuth(
      ips({ authentication: { mode: 'ALL_PROTECTED' } as unknown as AuthConfig }),
    );
    expect(resolved.accessTokenExpiresIn).toBe('15m');
    expect(resolved.refreshTokenExpiresIn).toBe('7d');
  });

  it('defaults signup and signin ON for an enabled mode', () => {
    // Authentication with no way to obtain a token is not a configuration
    // anybody chose — it is a document that lost a field.
    const resolved = projectAuth(
      ips({ authentication: { mode: 'ALL_PROTECTED' } as unknown as AuthConfig }),
    );
    expect(resolved.signup).toBe(true);
    expect(resolved.signin).toBe(true);
  });

  it('defaults cookie auth OFF, because enabling it changes CORS', () => {
    const resolved = projectAuth(
      ips({ authentication: { mode: 'ALL_PROTECTED' } as unknown as AuthConfig }),
    );
    expect(resolved.cookieAuth).toBe(false);
  });

  it('ignores the toggles entirely when the mode is NONE', () => {
    // A half-written document must not produce a signin endpoint on a project
    // whose author never enabled authentication.
    const resolved = projectAuth(
      ips({
        authentication: { mode: 'NONE', signup: true, signin: true } as unknown as AuthConfig,
      }),
    );
    expect(resolved).toEqual(NO_AUTH);
  });

  it('treats an unrecognised mode as NONE rather than trusting it', () => {
    const resolved = projectAuth(
      ips({ authentication: { mode: 'ALL_THE_THINGS' } as unknown as AuthConfig }),
    );
    expect(resolved.mode).toBe('NONE');
  });

  it('drops a malformed custom field instead of throwing', () => {
    // This runs over historical documents and over whatever was PATCHed before
    // validation tightened. A bad entry must not be able to break a comparison
    // of two old versions; the validator is where the author sees the error.
    const resolved = projectAuth(
      ips({
        authentication: {
          mode: 'ALL_PROTECTED',
          userFields: [
            { name: 'age', type: 'number', required: true },
            { type: 'string' },
            null,
            7,
          ],
        } as unknown as AuthConfig,
      }),
    );
    expect(resolved.userFields).toEqual([{ name: 'age', type: 'number', required: true }]);
  });

  it('narrows an unknown field type to string', () => {
    const resolved = projectAuth(
      ips({
        authentication: {
          mode: 'ALL_PROTECTED',
          userFields: [{ name: 'avatar', type: 'blob' }],
        } as unknown as AuthConfig,
      }),
    );
    expect(resolved.userFields).toEqual([{ name: 'avatar', type: 'string', required: false }]);
  });
});

describe('entityAuth: the mode decides, the entity only breaks ties', () => {
  it('is PUBLIC for every entity under ALL_PUBLIC', () => {
    expect(entityAuth(config('ALL_PUBLIC'), entity('Payment'))).toBe('PUBLIC');
  });

  it('is PROTECTED for every entity under ALL_PROTECTED', () => {
    expect(entityAuth(config('ALL_PROTECTED'), entity('Product'))).toBe('PROTECTED');
  });

  /**
   * The security-relevant one. An entity keeps its `authentication` field when
   * it has been in combination mode before, and a stale `PUBLIC` must not punch
   * a hole through `ALL_PROTECTED`.
   */
  it('does not let a stale PUBLIC stamp override ALL_PROTECTED', () => {
    expect(entityAuth(config('ALL_PROTECTED'), entity('Payment', 'PUBLIC'))).toBe('PROTECTED');
  });

  it('does not let a stale PROTECTED stamp override ALL_PUBLIC', () => {
    expect(entityAuth(config('ALL_PUBLIC'), entity('Payment', 'PROTECTED'))).toBe('PUBLIC');
  });

  it('reads the entity only under COMBINATION', () => {
    const combination = config('COMBINATION');
    expect(entityAuth(combination, entity('Product', 'PUBLIC'))).toBe('PUBLIC');
    expect(entityAuth(combination, entity('Payment', 'PROTECTED'))).toBe('PROTECTED');
  });

  /**
   * Fail closed. An unstamped entity in combination mode is a document that
   * lost a field — guessing PUBLIC would expose an endpoint the author never
   * marked public, and silently. A wrong 401 is visible and fixable.
   */
  it('falls back to PROTECTED for an unstamped entity in COMBINATION', () => {
    expect(entityAuth(config('COMBINATION'), entity('Payment'))).toBe('PROTECTED');
  });

  it('treats a garbage value as PROTECTED, not as public', () => {
    expect(
      entityAuth(config('COMBINATION'), { authentication: 'public' as unknown as 'PUBLIC' }),
    ).toBe('PROTECTED');
  });
});

describe('protectedEntities', () => {
  it('names only the protected ones, in declaration order', () => {
    const document = ips({
      entities: [
        entity('Product', 'PUBLIC'),
        entity('Order', 'PROTECTED'),
        entity('Category', 'PUBLIC'),
        entity('Payment', 'PROTECTED'),
      ],
      authentication: config('COMBINATION'),
    });
    expect(protectedEntities(document).map((e) => e.name)).toEqual(['Order', 'Payment']);
  });

  it('is every entity under ALL_PROTECTED, stamps or no stamps', () => {
    const document = ips({ authentication: config('ALL_PROTECTED') });
    expect(protectedEntities(document)).toHaveLength(2);
  });
});

describe('stampEntityAuth', () => {
  /**
   * The surprise this exists to prevent: switching ALL_PUBLIC → COMBINATION
   * with no stamping hands every entity to the fail-closed fallback and takes
   * the whole API dark in one click — a breaking change the user did not ask
   * for, reported as one row per entity.
   */
  it('preserves what was true when entering COMBINATION from ALL_PUBLIC', () => {
    const document = stampEntityAuth(ips({ authentication: config('ALL_PUBLIC') }), 'COMBINATION');

    expect(document.authentication?.mode).toBe('COMBINATION');
    expect(document.entities.map((e) => e.authentication)).toEqual(['PUBLIC', 'PUBLIC']);
    expect(protectedEntities(document)).toEqual([]);
  });

  it('preserves what was true when entering COMBINATION from ALL_PROTECTED', () => {
    const document = stampEntityAuth(
      ips({ authentication: config('ALL_PROTECTED') }),
      'COMBINATION',
    );
    expect(document.entities.map((e) => e.authentication)).toEqual(['PROTECTED', 'PROTECTED']);
  });

  it('stamps PUBLIC when entering COMBINATION from a project with no auth at all', () => {
    // Mode NONE means everything was open, so combination mode starts open —
    // turning authentication on must not also protect everything.
    const document = stampEntityAuth(ips(), 'COMBINATION');
    expect(document.entities.map((e) => e.authentication)).toEqual(['PUBLIC', 'PUBLIC']);
  });

  /**
   * Leaving a stale value behind is how the field later contradicts the mode
   * actually in force — and `entityAuth` ignores it, so the two would disagree
   * about the same entity depending on which one you read.
   */
  it('clears the stamps when leaving COMBINATION', () => {
    const document = stampEntityAuth(
      ips({
        entities: [entity('Product', 'PUBLIC'), entity('Payment', 'PROTECTED')],
        authentication: config('COMBINATION'),
      }),
      'ALL_PROTECTED',
    );
    expect(document.entities.every((e) => e.authentication === undefined)).toBe(true);
  });

  it('keeps every other setting across a mode change', () => {
    const document = stampEntityAuth(
      ips({
        authentication: config('ALL_PROTECTED', {
          cookieAuth: true,
          accessTokenExpiresIn: '5m',
          userFields: [{ name: 'name', type: 'string', required: true }],
        }),
      }),
      'COMBINATION',
    );
    expect(document.authentication?.cookieAuth).toBe(true);
    expect(document.authentication?.accessTokenExpiresIn).toBe('5m');
    expect(document.authentication?.userFields).toHaveLength(1);
  });

  it('turning authentication off leaves no protected entity behind', () => {
    const document = stampEntityAuth(
      ips({
        entities: [entity('Product', 'PUBLIC'), entity('Payment', 'PROTECTED')],
        authentication: config('COMBINATION'),
      }),
      'NONE',
    );
    expect(protectedEntities(document)).toEqual([]);
    expect(authEnabled(projectAuth(document))).toBe(false);
  });
});

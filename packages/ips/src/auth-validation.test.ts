import { describe, it, expect } from 'vitest';

import { validateIPS } from './validator.js';

/**
 * Validating the authentication block (Phase 3 §15, §23).
 *
 * `projectAuth` deliberately tolerates junk so that comparing two historical
 * versions cannot crash. This is the counterpart that stops junk being written
 * in the first place — without it, the tolerance would be the only behaviour and
 * a typo would silently resolve to a default forever.
 */

const base = () => ({
  projectId: 'p1',
  version: 1,
  entities: [{ name: 'Product', fields: [{ name: 'id', type: 'uuid', required: true }] }],
  generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 5 },
});

const validate = (authentication: unknown) => validateIPS({ ...base(), authentication });

/** The issue strings for one path, so a test asserts the message not the index. */
function issuesAt(result: ReturnType<typeof validateIPS>, path: string): string[] {
  if (result.ok) {
    return [];
  }
  return (result.error.details ?? [])
    .filter((detail) => detail.path === path)
    .map((detail) => detail.issue);
}

const ok = (authentication: unknown) => validate(authentication).ok;

describe('§26: absent is valid', () => {
  it('accepts a project with no authentication block', () => {
    expect(validateIPS(base()).ok).toBe(true);
  });

  it('accepts an explicit NONE', () => {
    expect(ok({ mode: 'NONE' })).toBe(true);
  });
});

describe('the mode', () => {
  it('accepts each of the four', () => {
    for (const mode of ['NONE', 'ALL_PUBLIC', 'ALL_PROTECTED', 'COMBINATION']) {
      expect(ok({ mode }), mode).toBe(true);
    }
  });

  it('rejects an unrecognised mode rather than defaulting it', () => {
    const result = validate({ mode: 'ALL_THE_THINGS' });
    expect(issuesAt(result, 'authentication.mode')).toHaveLength(1);
  });

  it('rejects a missing mode', () => {
    expect(issuesAt(validate({ signup: true }), 'authentication.mode')).toHaveLength(1);
  });

  it('rejects a block that is not an object', () => {
    expect(issuesAt(validate('ALL_PROTECTED'), 'authentication')).toHaveLength(1);
    expect(issuesAt(validate([{ mode: 'NONE' }]), 'authentication')).toHaveLength(1);
  });
});

describe('token lifetimes', () => {
  it('accepts the §7/§8 duration grammar', () => {
    for (const ttl of ['15m', '7d', '900s', '24h', '1m']) {
      expect(ok({ mode: 'ALL_PROTECTED', accessTokenExpiresIn: ttl }), ttl).toBe(true);
    }
  });

  it('rejects a bare number, which would be ambiguous', () => {
    // 900 seconds or 900 milliseconds? The unit is not optional.
    expect(
      issuesAt(
        validate({ mode: 'ALL_PROTECTED', accessTokenExpiresIn: '900' }),
        'authentication.accessTokenExpiresIn',
      ),
    ).toHaveLength(1);
  });

  it('rejects zero and negatives', () => {
    for (const ttl of ['0m', '-5m']) {
      expect(ok({ mode: 'ALL_PROTECTED', refreshTokenExpiresIn: ttl }), ttl).toBe(false);
    }
  });

  it('rejects a non-string', () => {
    expect(ok({ mode: 'ALL_PROTECTED', accessTokenExpiresIn: 900 })).toBe(false);
  });
});

describe('a locked door with no key', () => {
  /**
   * A project that requires authentication with signin disabled 401s every
   * endpoint and can never issue a token. Generating that API is worse than
   * refusing to: nothing in the product would explain why every request fails.
   */
  it('refuses to disable signin while authentication is enabled', () => {
    expect(
      issuesAt(validate({ mode: 'ALL_PROTECTED', signin: false }), 'authentication.signin'),
    ).toHaveLength(1);
  });

  it('allows signin false when the mode is NONE', () => {
    // There is no Auth API at all, so the flag is inert rather than harmful.
    expect(ok({ mode: 'NONE', signin: false })).toBe(true);
  });

  it('allows signup to be disabled, which is a real configuration', () => {
    // An invite-only API: accounts exist, but not through a public endpoint.
    expect(ok({ mode: 'ALL_PROTECTED', signup: false })).toBe(true);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      issuesAt(validate({ mode: 'ALL_PROTECTED', cookieAuth: 'yes' }), 'authentication.cookieAuth'),
    ).toHaveLength(1);
  });
});

describe('custom signup fields (§5)', () => {
  const withFields = (userFields: unknown) => validate({ mode: 'ALL_PROTECTED', userFields });

  it('accepts the three types', () => {
    expect(
      withFields([
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'number', required: false },
        { name: 'optIn', type: 'boolean', required: false },
      ]).ok,
    ).toBe(true);
  });

  /**
   * The security-relevant check.
   *
   * §23 forbids exposing a password hash and §10 forbids returning one from
   * `/me`. A custom field named `passwordHash` would be written straight from
   * the signup body and echoed back as ordinary user data — defeating both
   * rules without either being violated in code. This is the only place it can
   * be caught.
   */
  it('rejects a field that shadows a reserved one', () => {
    for (const name of ['passwordHash', 'password', 'email', 'id', 'createdAt', 'updatedAt']) {
      const result = withFields([{ name, type: 'string', required: false }]);
      expect(issuesAt(result, 'authentication.userFields[0].name'), name).toHaveLength(1);
    }
  });

  it('rejects two fields with the same name', () => {
    const result = withFields([
      { name: 'nickname', type: 'string', required: false },
      { name: 'nickname', type: 'number', required: false },
    ]);
    expect(issuesAt(result, 'authentication.userFields[1].name')).toHaveLength(1);
  });

  it('rejects an unsupported type rather than narrowing it', () => {
    // `projectAuth` narrows an unknown type to string so an old document still
    // reads; the author writing one now must be told instead.
    const result = withFields([{ name: 'avatar', type: 'blob' }]);
    expect(issuesAt(result, 'authentication.userFields[0].type')).toHaveLength(1);
  });

  it('rejects a name that is not an identifier', () => {
    expect(withFields([{ name: 'first name', type: 'string' }]).ok).toBe(false);
    expect(withFields([{ name: '1st', type: 'string' }]).ok).toBe(false);
  });

  it('rejects a non-array and a non-object entry', () => {
    expect(issuesAt(withFields({ name: 'x' }), 'authentication.userFields')).toHaveLength(1);
    expect(issuesAt(withFields([null]), 'authentication.userFields[0]')).toHaveLength(1);
  });

  it('accepts an omitted required flag', () => {
    expect(withFields([{ name: 'nickname', type: 'string' }]).ok).toBe(true);
  });
});

describe('entity protection', () => {
  const withEntityAuth = (authentication: unknown) =>
    validateIPS({
      ...base(),
      authentication: { mode: 'COMBINATION' },
      entities: [
        {
          name: 'Product',
          fields: [{ name: 'id', type: 'uuid', required: true }],
          authentication,
        },
      ],
    });

  it('accepts PUBLIC and PROTECTED', () => {
    expect(withEntityAuth('PUBLIC').ok).toBe(true);
    expect(withEntityAuth('PROTECTED').ok).toBe(true);
  });

  /**
   * `entityAuth` fails closed on anything unrecognised, so a lowercase
   * `'public'` silently *protects* the entity. Safe, but not what the author
   * wrote — and their only clue would be a 401 they cannot explain.
   */
  it('rejects a lowercase value rather than silently protecting the entity', () => {
    expect(issuesAt(withEntityAuth('public'), 'entities[0].authentication')).toHaveLength(1);
  });

  it('rejects a boolean, which is the obvious wrong shape to reach for', () => {
    expect(withEntityAuth(true).ok).toBe(false);
  });

  /**
   * A stale stamp from a previous stint in COMBINATION is harmless — the helper
   * ignores the field outside that mode — and rejecting its presence would
   * break a PATCH that faithfully round-trips an older document.
   */
  it('accepts a stamp under a whole-project mode', () => {
    const result = validateIPS({
      ...base(),
      authentication: { mode: 'ALL_PROTECTED' },
      entities: [
        {
          name: 'Product',
          fields: [{ name: 'id', type: 'uuid', required: true }],
          authentication: 'PUBLIC',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

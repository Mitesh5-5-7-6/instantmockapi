import { describe, it, expect } from 'vitest';

import {
  AUTH_ENDPOINT_OPTIONS,
  PROJECT_CHOICES,
  REQUIRED_AUTH_ENDPOINTS,
  SIMPLE_CHOICES,
  authProjectConfig,
  describeAuthProject,
  configForChoice,
  describeChoice,
  emptySelectionWarning,
  previewEndpoints,
  stampChoices,
} from './auth-onboarding';
import { authConfigOf, authProblems, entityAuthRows } from './auth-config';
import type { IpsAuthShape } from './api-types';

/**
 * The wizard's authentication question.
 *
 * Two things are being tested: that the copy stays out of the stored
 * vocabulary, and that the answer produces exactly the configuration the Auth
 * tab would show — so the next screen never contradicts the choice.
 */

const ENTITIES = [{ name: 'Product' }, { name: 'Order' }];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

describe('the questions', () => {
  /**
   * §1 is explicit that a Single API must not be given the Project API's
   * configuration. `COMBINATION` on one resource has nothing to choose between,
   * so offering it would be a menu item that does nothing.
   */
  it('offers a Single API two options and no per-entity choice', () => {
    expect(SIMPLE_CHOICES).toHaveLength(2);
    expect(SIMPLE_CHOICES.map((choice) => choice.mode)).not.toContain('COMBINATION');
  });

  it('offers a Project API the per-entity choice', () => {
    expect(PROJECT_CHOICES.map((choice) => choice.mode)).toContain('COMBINATION');
  });

  /**
   * The copy is for someone who has not met the concept. The stored vocabulary
   * is introduced by the endpoint preview and the Auth tab, not assumed by the
   * question.
   */
  it('asks in plain language rather than in the stored vocabulary', () => {
    const copy = [...SIMPLE_CHOICES, ...PROJECT_CHOICES]
      .map((choice) => `${choice.label} ${choice.description}`)
      .join(' ');

    for (const jargon of ['PROTECTED', 'PUBLIC', 'COMBINATION', 'bearer', 'JWT', 'OAuth']) {
      expect(copy, jargon).not.toContain(jargon);
    }
  });

  it('says what happens rather than what the setting is called', () => {
    for (const choice of [...SIMPLE_CHOICES, ...PROJECT_CHOICES]) {
      expect(choice.description.length, choice.mode).toBeGreaterThan(20);
    }
    // And the reassurance that the decision is not final, which is what stops
    // a first-time user stalling on it.
    expect(SIMPLE_CHOICES[0]!.description).toContain('later');
  });
});

describe('configForChoice', () => {
  /**
   * Declining produces **no block at all**, not `{ mode: 'NONE' }`.
   *
   * A stored off-switch would make "never asked" and "asked and declined"
   * different documents that behave identically — and the first version's diff
   * would then report a setting nobody chose.
   */
  it('returns null when the user declines', () => {
    expect(configForChoice('NONE')).toBeNull();
  });

  it('turns sign-up, sign-in and refresh on for any enabled answer', () => {
    for (const mode of ['ALL_PROTECTED', 'COMBINATION'] as const) {
      const config = configForChoice(mode)!;
      expect(config.signup, mode).toBe(true);
      expect(config.signin, mode).toBe(true);
      expect(config.refreshToken, mode).toBe(true);
    }
  });

  /**
   * Cookie mode changes the sign-in response shape and needs CORS thought
   * about. That is not a first-run decision, and defaulting it on would break
   * the copy-paste `accessToken` a new user expects.
   */
  it('leaves cookie mode off', () => {
    expect(configForChoice('ALL_PROTECTED')!.cookieAuth).toBe(false);
  });

  it('produces a configuration the Auth tab reads back unchanged', () => {
    // The wizard and the tab must agree, or the first visit to the tab would
    // appear to show a different project than the one just created.
    const ips: IpsAuthShape = {
      entities: ENTITIES,
      authentication: configForChoice('ALL_PROTECTED')!,
    };
    expect(authConfigOf(ips).mode).toBe('ALL_PROTECTED');
    expect(entityAuthRows(ips).every((row) => row.auth === 'PROTECTED')).toBe(true);
  });
});

describe('stampChoices', () => {
  it('marks the ticked entities protected and the rest public', () => {
    const stamped = stampChoices(ENTITIES, ['Order']);
    expect(stamped).toEqual([
      { name: 'Product', authentication: 'PUBLIC' },
      { name: 'Order', authentication: 'PROTECTED' },
    ]);
  });

  /**
   * Unticked means public *here*, which is the opposite of the runtime's
   * fail-closed fallback — deliberately. This list is the user's own answer to a
   * question they were just asked, so an empty box means "no". The runtime's
   * fallback covers a document that lost a field, where there is no answer to
   * honour.
   */
  it('treats an empty selection as everything public', () => {
    const stamped = stampChoices(ENTITIES, []);
    expect(stamped.every((entity) => entity.authentication === 'PUBLIC')).toBe(true);
  });

  it('feeds straight into the tab’s resolved view', () => {
    const ips: IpsAuthShape = {
      entities: stampChoices(ENTITIES, ['Order']),
      authentication: configForChoice('COMBINATION')!,
    };
    const rows = entityAuthRows(ips);
    expect(rows.find((row) => row.name === 'Order')!.auth).toBe('PROTECTED');
    expect(rows.find((row) => row.name === 'Product')!.auth).toBe('PUBLIC');
  });
});

describe('previewEndpoints', () => {
  const preview = (mode: 'NONE' | 'ALL_PROTECTED' | 'COMBINATION', protectedNames: string[] = []) =>
    previewEndpoints({
      mode,
      entities: ENTITIES,
      protectedNames,
      methods: METHODS,
      signup: true,
      refreshToken: true,
    });

  /** With no authentication there is no Auth API to show. */
  it('shows no auth endpoints when the user declined', () => {
    const rows = preview('NONE');
    expect(rows.some((row) => row.isAuthApi)).toBe(false);
    expect(rows.every((row) => !row.requiresAuth)).toBe(true);
  });

  it('lists the five auth endpoints when authentication is on', () => {
    const paths = preview('ALL_PROTECTED')
      .filter((row) => row.isAuthApi)
      .map((row) => row.path);
    expect(paths).toEqual(['/signUp', '/signIn', '/refresh', '/me', '/logout']);
  });

  /**
   * Obtaining a credential cannot require one, and the preview has to show
   * that — otherwise the list reads as a chicken-and-egg problem.
   */
  it('shows sign-up and sign-in as not needing a token', () => {
    const rows = preview('ALL_PROTECTED').filter((row) => row.isAuthApi);
    expect(rows.find((row) => row.path === '/signIn')!.requiresAuth).toBe(false);
    expect(rows.find((row) => row.path === '/signUp')!.requiresAuth).toBe(false);
    expect(rows.find((row) => row.path === '/me')!.requiresAuth).toBe(true);
  });

  it('marks every entity endpoint when everything is protected', () => {
    const rows = preview('ALL_PROTECTED').filter((row) => !row.isAuthApi);
    expect(rows.length).toBe(ENTITIES.length * METHODS.length);
    expect(rows.every((row) => row.requiresAuth)).toBe(true);
  });

  /** The whole point of the per-entity answer, shown rather than described. */
  it('marks only the chosen entity in per-entity mode', () => {
    const rows = preview('COMBINATION', ['Order']).filter((row) => !row.isAuthApi);
    expect(rows.filter((row) => row.path.includes('order')).every((row) => row.requiresAuth)).toBe(
      true,
    );
    expect(
      rows.filter((row) => row.path.includes('product')).every((row) => !row.requiresAuth),
    ).toBe(true);
  });

  /**
   * All methods of an entity share the setting (§2C), including DELETE — the
   * one where a gap matters most. The preview must not imply otherwise.
   */
  it('marks DELETE alongside the readable methods', () => {
    const rows = preview('COMBINATION', ['Order']).filter(
      (row) => !row.isAuthApi && row.path.includes('order'),
    );
    const del = rows.find((row) => row.method === 'DELETE')!;
    expect(del.requiresAuth).toBe(true);
    expect(del.path).toBe('/order/{id}');
  });

  it('addresses records for the record-shaped methods only', () => {
    const rows = preview('NONE').filter((row) => row.path.includes('product'));
    expect(rows.find((row) => row.method === 'GET')!.path).toBe('/product');
    expect(rows.find((row) => row.method === 'POST')!.path).toBe('/product');
    expect(rows.find((row) => row.method === 'PUT')!.path).toBe('/product/{id}');
  });

  it('omits an auth endpoint the configuration does not generate', () => {
    const rows = previewEndpoints({
      mode: 'ALL_PROTECTED',
      entities: ENTITIES,
      protectedNames: [],
      methods: ['GET'],
      signup: false,
      refreshToken: false,
    });
    const paths = rows.filter((row) => row.isAuthApi).map((row) => row.path);
    expect(paths).not.toContain('/signUp');
    expect(paths).not.toContain('/refresh');
    expect(paths).toContain('/signIn');
  });
});

describe('describeChoice', () => {
  it('states the consequence for each answer', () => {
    expect(describeChoice('NONE', 0, 2)).toContain('open');
    expect(describeChoice('ALL_PROTECTED', 2, 2)).toContain('Every endpoint');
    expect(describeChoice('COMBINATION', 1, 2)).toBe('1 of 2 entities require a signed-in caller.');
  });

  it('gets the singular right', () => {
    expect(describeChoice('COMBINATION', 1, 1)).toContain('1 of 1 entity');
  });

  it('does not claim protection when nothing was selected', () => {
    expect(describeChoice('COMBINATION', 0, 3)).toContain('not marked any');
  });
});

describe('emptySelectionWarning', () => {
  /**
   * Choosing "some of it" and ticking nothing is a valid configuration but
   * almost certainly not what the user meant one click later. Better said
   * before they generate than discovered as an open API.
   */
  it('warns when per-entity was chosen and nothing ticked', () => {
    const warning = emptySelectionWarning('COMBINATION', 0);
    expect(warning).not.toBeNull();
    expect(warning).toContain('everything will be open');
  });

  it('is silent once something is ticked', () => {
    expect(emptySelectionWarning('COMBINATION', 1)).toBeNull();
  });

  it('is silent for the other answers, which are not ambiguous', () => {
    expect(emptySelectionWarning('NONE', 0)).toBeNull();
    expect(emptySelectionWarning('ALL_PROTECTED', 0)).toBeNull();
  });
});

describe('the Auth API project kind', () => {
  /**
   * Sign-in is not offered as a choice.
   *
   * A project that requires a token with no way to obtain one is a locked door
   * with no key — which the client's `authProblems` and the server's validator
   * both refuse. A checkbox for it would be a checkbox for an invalid
   * configuration.
   */
  it('offers only the genuinely optional endpoints', () => {
    expect(AUTH_ENDPOINT_OPTIONS.map((option) => option.key)).toEqual(['signup', 'refreshToken']);
  });

  it('names the route each option produces', () => {
    for (const option of AUTH_ENDPOINT_OPTIONS) {
      expect(option.route, option.key).toMatch(/^(GET|POST) \//);
    }
  });

  it('lists sign-in, /me and logout as always generated', () => {
    const routes = REQUIRED_AUTH_ENDPOINTS.map((entry) => entry.route);
    expect(routes).toEqual(['POST /signIn', 'GET /me', 'POST /logout']);
  });

  /**
   * `ALL_PUBLIC`, not a fifth mode. The reading is exact: the Auth API exists,
   * and no *entity* requires a token because there are no entities. Inventing
   * `AUTH_ONLY` would have to be handled in `entityAuth`, the diff, the
   * classification table, both generators and the runtime — to express what
   * this already says.
   */
  it('stores ALL_PUBLIC with sign-in always on', () => {
    const config = authProjectConfig({
      signup: true,
      refreshToken: true,
      cookieAuth: false,
      userFields: [],
    });
    expect(config.mode).toBe('ALL_PUBLIC');
    expect(config.signin).toBe(true);
  });

  it('honours the endpoint choices', () => {
    const config = authProjectConfig({
      signup: false,
      refreshToken: false,
      cookieAuth: true,
      userFields: [],
    });
    expect(config.signup).toBe(false);
    expect(config.refreshToken).toBe(false);
    expect(config.cookieAuth).toBe(true);
    // Still valid — sign-in survives whatever else is turned off.
    expect(config.signin).toBe(true);
  });

  it('carries the extra sign-up fields through', () => {
    const config = authProjectConfig({
      signup: true,
      refreshToken: true,
      cookieAuth: false,
      userFields: [{ name: 'displayName', type: 'string', required: true }],
    });
    expect(config.userFields).toEqual([{ name: 'displayName', type: 'string', required: true }]);
  });

  /**
   * The configuration must pass the same validation the Auth tab applies, or
   * the wizard would create a project the tab immediately reports as broken.
   */
  it('produces a configuration with no problems', () => {
    const config = authProjectConfig({
      signup: false,
      refreshToken: false,
      cookieAuth: false,
      userFields: [{ name: 'displayName', type: 'string', required: true }],
    });
    expect(authProblems({ entities: [], authentication: config })).toEqual([]);
  });

  it('reports a reserved extra field as a problem', () => {
    const config = authProjectConfig({
      signup: true,
      refreshToken: true,
      cookieAuth: false,
      userFields: [{ name: 'passwordHash', type: 'string', required: false }],
    });
    expect(authProblems({ entities: [], authentication: config }).length).toBeGreaterThan(0);
  });

  describe('describeAuthProject', () => {
    const config = (over: Partial<Parameters<typeof authProjectConfig>[0]> = {}) =>
      authProjectConfig({
        signup: true,
        refreshToken: true,
        cookieAuth: false,
        userFields: [],
        ...over,
      });

    /** Counts endpoints rather than naming the mode — `ALL_PUBLIC` would be
        actively confusing on a project whose whole purpose is authentication. */
    it('counts the endpoints and never names the mode', () => {
      expect(describeAuthProject(config())).toBe('5 endpoints');
      expect(describeAuthProject(config())).not.toContain('PUBLIC');
    });

    it('drops the count when endpoints are turned off', () => {
      expect(describeAuthProject(config({ signup: false, refreshToken: false }))).toBe(
        '3 endpoints',
      );
    });

    it('mentions the extra fields, with the right plural', () => {
      expect(
        describeAuthProject(
          config({ userFields: [{ name: 'displayName', type: 'string', required: true }] }),
        ),
      ).toContain('1 extra field on sign-up');
    });

    it('ignores an unnamed field row the user has not filled in', () => {
      expect(
        describeAuthProject(
          config({ userFields: [{ name: '', type: 'string', required: false }] }),
        ),
      ).toBe('5 endpoints');
    });
  });
});

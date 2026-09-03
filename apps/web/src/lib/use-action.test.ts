import { describe, it, expect } from 'vitest';

import { ApiError, NetworkError } from './api-client';
import { normalizeError } from './errors';
import { PathIndexBuilder, type FieldPathIndex } from './error-paths';
import { planRouting } from './use-action';

/** The index the project wizard builds for a two-field entity. */
function index(): FieldPathIndex {
  const builder = new PathIndexBuilder();
  builder.at('entities', 0, () => {
    builder.claim('ent-user');
    builder.at('fields', 0, () => builder.claim('fld-name'));
    builder.at('fields', 1, () => builder.claim('fld-email'));
  });
  return builder.build();
}

const validationFailure = (details: { path: string; issue: string }[]) =>
  normalizeError(new ApiError(422, 'VALIDATION_ERROR', 'IPS validation failed', details));

describe('server detail that maps to fields', () => {
  /**
   * The transformation the whole change exists for. §32: inline errors say what
   * to fix, and one toast says the operation failed.
   */
  it('goes inline AND raises exactly one toast', () => {
    const plan = planRouting(
      validationFailure([
        { path: 'entities[0].fields[1].name', issue: 'must be alphanumeric' },
        { path: 'entities[0].name', issue: 'is invalid' },
      ]),
      index(),
      false,
    );

    expect([...plan.fieldErrors.keys()].sort()).toEqual(['ent-user', 'fld-email']);
    expect(plan.toast).toBe(true);
    expect(plan.toastDetail).toBe('2 fields need attention.');
  });

  it('summarises one field in the singular', () => {
    const plan = planRouting(
      validationFailure([{ path: 'entities[0].fields[0].name', issue: 'is required' }]),
      index(),
      false,
    );
    expect(plan.toastDetail).toBe('1 field needs attention.');
  });

  /**
   * Folding an unmappable issue into the inline count would leave the user
   * fixing the highlighted field and unable to work out why a second failure
   * persists.
   */
  it('states separately anything with no inline home', () => {
    const plan = planRouting(
      validationFailure([
        { path: 'entities[0].fields[0].name', issue: 'is required' },
        { path: 'generationConfig.methods', issue: 'at least one is required' },
      ]),
      index(),
      false,
    );

    expect(plan.fieldErrors.size).toBe(1);
    expect(plan.toastDetail).toBe('1 field needs attention. 1 other issue.');
  });

  it('pluralises the remainder', () => {
    const plan = planRouting(
      validationFailure([
        { path: 'entities[0].fields[0].name', issue: 'is required' },
        { path: 'generationConfig.methods', issue: 'required' },
        { path: 'projectId', issue: 'required' },
      ]),
      index(),
      false,
    );
    expect(plan.toastDetail).toBe('1 field needs attention. 2 other issues.');
  });
});

describe('server detail that maps to nothing', () => {
  it('is toast-only, with no inline messages', () => {
    const plan = planRouting(
      validationFailure([{ path: 'generationConfig.methods', issue: 'required' }]),
      index(),
      false,
    );

    expect(plan.fieldErrors.size).toBe(0);
    expect(plan.toast).toBe(true);
    // The normaliser's own summary stands; nothing was routed to change it.
    expect(plan.toastDetail).toBeNull();
  });

  /** An action with no form behind it passes no index, so nothing can map. */
  it('is toast-only when no index is supplied', () => {
    const plan = planRouting(
      validationFailure([{ path: 'entities[0].fields[0].name', issue: 'is required' }]),
      null,
      false,
    );
    expect(plan.fieldErrors.size).toBe(0);
    expect(plan.toast).toBe(true);
  });
});

describe('form-wide failures', () => {
  it('render in the form and raise a toast', () => {
    const plan = planRouting(
      normalizeError(new ApiError(409, 'CONFLICT', 'Slug taken')),
      null,
      true,
    );
    expect(plan.form).toBe(true);
    expect(plan.toast).toBe(true);
  });

  it('stay out of the form when the caller did not ask', () => {
    const plan = planRouting(
      normalizeError(new ApiError(409, 'CONFLICT', 'Slug taken')),
      null,
      false,
    );
    expect(plan.form).toBe(false);
    expect(plan.toast).toBe(true);
  });

  /** Inline and form-wide are not exclusive: a form may want both. */
  it('can be both inline and form-wide', () => {
    const plan = planRouting(
      validationFailure([{ path: 'entities[0].fields[0].name', issue: 'is required' }]),
      index(),
      true,
    );
    expect(plan.fieldErrors.size).toBe(1);
    expect(plan.form).toBe(true);
    expect(plan.toast).toBe(true);
  });
});

describe('a dead session', () => {
  /**
   * The one failure that raises no toast. `apiFetch` already refreshes and
   * retries once, so a surviving 401 means the session is genuinely gone and
   * the app is moving to signed-out — a notification read on the way to the
   * sign-in page adds nothing.
   */
  it('raises no toast', () => {
    const plan = planRouting(normalizeError(new ApiError(401, 'UNAUTHORIZED', '')), index(), false);
    expect(plan.toast).toBe(false);
    expect(plan.form).toBe(true);
    expect(plan.fieldErrors.size).toBe(0);
  });

  it('is not confused with a permission failure', () => {
    const plan = planRouting(normalizeError(new ApiError(403, 'FORBIDDEN', '')), null, false);
    expect(plan.toast).toBe(true);
  });
});

describe('failures with no detail to route', () => {
  it.each([
    ['network', new NetworkError(new TypeError('Failed to fetch'))],
    ['server', new ApiError(500, 'INTERNAL_ERROR', 'Internal server error')],
    ['unexpected', new TypeError('x is not a function')],
    ['rate limit', new ApiError(429, 'RATE_LIMIT_EXCEEDED', '')],
  ])('a %s failure is toast-only', (_label, cause) => {
    const plan = planRouting(normalizeError(cause), index(), false);
    expect(plan.toast).toBe(true);
    expect(plan.fieldErrors.size).toBe(0);
  });
});

describe('one action, one notification', () => {
  /**
   * §35: "One user action produces at most one appropriate global error
   * notification." The plan is a single value with a single boolean, so the
   * shape makes more than one impossible rather than merely discouraged.
   */
  it('is structurally guaranteed by the plan', () => {
    for (const cause of [
      new ApiError(422, 'VALIDATION_ERROR', 'nope', [
        { path: 'entities[0].fields[0].name', issue: 'a' },
        { path: 'entities[0].fields[1].name', issue: 'b' },
        { path: 'entities[0].name', issue: 'c' },
      ]),
      new ApiError(500, 'INTERNAL_ERROR', ''),
      new NetworkError(new Error()),
    ]) {
      const plan = planRouting(normalizeError(cause), index(), true);
      // A boolean cannot describe two toasts.
      expect(typeof plan.toast).toBe('boolean');
    }
  });

  it('routes three issues on one field to one inline entry and one toast', () => {
    const plan = planRouting(
      validationFailure([
        { path: 'entities[0].fields[0].name', issue: 'is required' },
        { path: 'entities[0].fields[0].type', issue: 'unknown type' },
        { path: 'entities[0].fields[0].default', issue: 'wrong shape' },
      ]),
      index(),
      false,
    );

    expect(plan.fieldErrors.size).toBe(1);
    expect(plan.fieldErrors.get('fld-name')).toHaveLength(3);
    expect(plan.toastDetail).toBe('1 field needs attention.');
  });
});

describe('suppressing the toast', () => {
  /**
   * On a sign-in page the form IS the screen and a `FormError` sits at the
   * submit button, so a toast repeats the identical sentence in a second place
   * at the same moment — the duplicate-notification problem in different
   * clothes. Allowed only there, and only explicitly.
   */
  it('renders in the form alone when the caller opts out', () => {
    const plan = planRouting(
      normalizeError(new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password')),
      null,
      true,
      false,
    );
    expect(plan.form).toBe(true);
    expect(plan.toast).toBe(false);
  });

  it('still suppresses when detail mapped to fields', () => {
    const plan = planRouting(
      validationFailure([{ path: 'entities[0].fields[0].name', issue: 'is required' }]),
      index(),
      true,
      false,
    );
    expect(plan.fieldErrors.size).toBe(1);
    expect(plan.toast).toBe(false);
  });

  /** The default must be loud: nothing should go silent by omission. */
  it('defaults to raising a toast', () => {
    expect(planRouting(normalizeError(new ApiError(500, 'X', '')), null, false).toast).toBe(true);
  });
});

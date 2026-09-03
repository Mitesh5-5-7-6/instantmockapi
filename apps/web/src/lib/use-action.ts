'use client';

/**
 * The one place that decides where a failure is shown.
 *
 * Wrapping a react-query mutation with this is what makes an action's whole
 * lifecycle — loading, success, failure, and *where the failure appears* —
 * a declaration rather than a per-screen improvisation.
 *
 * ## Why the API client does not do this
 *
 * It would be less code to toast from `apiFetch`. It would also be wrong: the
 * client cannot know whether a validation failure has fields to route to, and a
 * toast raised there fires *in addition to* whatever the form does with the same
 * error. That is the duplicate-notification problem, and the only fix is for one
 * layer to own the decision. This is that layer.
 *
 * ## Why not react-query's `MutationCache.onError`
 *
 * Same reason, one level up: a global handler cannot see the form, so every
 * mapped validation error would get an inline message *and* an unconditional
 * generic toast.
 *
 * ## What a caller gets
 *
 *     const save = useAction(useSaveDraft(id), {
 *       success: 'Draft saved',
 *       fields: () => pathIndex,
 *       onFieldErrors: setFieldErrors,
 *     });
 *
 *     save.run(payload);          // routed for you
 *     save.isPending              // for the button
 *     save.formError              // for a <FormError>, when form-wide
 */

import { useCallback, useMemo, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';

import { countAffectedPaths, isSessionExpiry, normalizeError, type AppFailure } from './errors';
import { resolveDetails, type FieldPathIndex } from './error-paths';
import { notifyFailure, notifyLoading, notifySuccess, dismissToastByKey } from './toast';

export interface ActionOptions<TData, TVariables> {
  /** Success notification. §18 — an action that succeeded should say so. */
  success?: string | ((data: TData, variables: TVariables) => string) | undefined;
  /** Notification while in flight, replaced in place by the outcome. */
  loading?: string | undefined;
  /**
   * Where to route server field detail.
   *
   * Return the index the payload builder produced. Omit it and every detail is
   * unmappable by definition, so the failure becomes a toast — correct for an
   * action with no form behind it.
   */
  fields?: (() => FieldPathIndex) | undefined;
  /** Receives builder-node id → messages, for the form to render inline. */
  onFieldErrors?: ((byId: Map<string, string[]>) => void) | undefined;
  /**
   * Treat a failure as belonging to the whole form, for a `<FormError>`.
   *
   * Combines with `toast` below rather than replacing it: on a long form the
   * inline block can be scrolled out of view, so both are usually right.
   */
  formError?: boolean | undefined;
  /**
   * Raise a toast. Defaults to true, so nothing goes silent by accident.
   *
   * Set false only where the form **is** the screen and a `FormError` sits at
   * the submit button — a sign-in page, a password reset. There a toast repeats
   * the identical sentence in a second place at the same moment, which is the
   * duplicate-notification problem wearing different clothes.
   *
   * Never set it false for an action the user can navigate away from.
   */
  toast?: boolean | undefined;
  /** Action button on the failure toast — `Sign in`, `Retry`, and so on. */
  onFailureAction?: { label: string; onClick: (failure: AppFailure) => void } | undefined;
  /** Called after the failure has been routed, for anything screen-specific. */
  onFailure?: ((failure: AppFailure) => void) | undefined;
}

export interface Action<TData, TVariables> {
  run: (variables: TVariables) => Promise<TData | null>;
  isPending: boolean;
  /** Set when the last failure was form-wide. Cleared on the next attempt. */
  formError: AppFailure | null;
  /** The last failure, whatever its destination. Cleared on the next attempt. */
  failure: AppFailure | null;
  /** Drop the rendered error state without retrying. */
  reset: () => void;
}

export function useAction<TData, TVariables>(
  mutation: UseMutationResult<TData, unknown, TVariables, unknown>,
  options: ActionOptions<TData, TVariables> = {},
): Action<TData, TVariables> {
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const [formError, setFormError] = useState<AppFailure | null>(null);

  const {
    success,
    loading,
    fields,
    onFieldErrors,
    formError: asFormError = false,
    toast: allowToast = true,
    onFailureAction,
    onFailure,
  } = options;

  const reset = useCallback(() => {
    setFailure(null);
    setFormError(null);
    onFieldErrors?.(new Map());
  }, [onFieldErrors]);

  const run = useCallback(
    async (variables: TVariables): Promise<TData | null> => {
      // Clearing first matters: a stale inline error next to a field the user
      // has since fixed reads as "still wrong", and they cannot tell that the
      // message is simply old.
      reset();

      const loadingKey =
        loading === undefined ? null : `action-${Math.random().toString(36).slice(2)}`;
      if (loading !== undefined && loadingKey !== null) {
        notifyLoading(loadingKey, loading);
      }

      try {
        const data = await mutation.mutateAsync(variables);
        if (loadingKey !== null) {
          dismissToastByKey(loadingKey);
        }
        if (success !== undefined) {
          notifySuccess(typeof success === 'function' ? success(data, variables) : success);
        }
        return data;
      } catch (cause) {
        if (loadingKey !== null) {
          dismissToastByKey(loadingKey);
        }

        const normalized = normalizeError(cause);
        setFailure(normalized);
        route(normalized, {
          fields,
          onFieldErrors,
          asFormError,
          allowToast,
          setFormError,
          onFailureAction,
        });
        onFailure?.(normalized);
        return null;
      }
    },
    [
      mutation,
      reset,
      success,
      loading,
      fields,
      onFieldErrors,
      asFormError,
      allowToast,
      onFailureAction,
      onFailure,
    ],
  );

  return useMemo(
    () => ({ run, isPending: mutation.isPending, formError, failure, reset }),
    [run, mutation.isPending, formError, failure, reset],
  );
}

/**
 * What should happen to one failure. The policy, as a value.
 *
 * Separated from the code that carries it out so the decision can be tested
 * without a DOM, a store or a rendered hook. This is the most consequential
 * logic in the change — get it wrong and the product either goes silent or
 * double-reports — so it should not be reachable only through a React callback.
 */
export interface RoutingPlan {
  /** Inline messages, keyed by builder node id. Empty when none mapped. */
  fieldErrors: Map<string, string[]>;
  /**
   * Show a toast. False for a dead session (the auth flow owns it) and where
   * the caller opted out because a `FormError` already sits at the submit button.
   */
  toast: boolean;
  /** Second line for the toast, when the plan changes it. */
  toastDetail: string | null;
  /** Render inside the form as well. */
  form: boolean;
}

/**
 * Decide where a failure goes.
 *
 * The ordering is the policy:
 *
 * 1. A dead session is the auth flow's problem — `restoreSession` has already
 *    moved the app to signed-out, and a toast the user reads on the way to the
 *    sign-in page adds nothing.
 * 2. Detail that maps to fields goes inline, **plus** one summarising toast.
 *    The toast says the operation failed; the fields say what to fix. Without
 *    the toast, a field scrolled out of view means a submission that failed with
 *    no visible sign at all.
 * 3. Detail that maps to nothing has no inline home, so it is toast-only.
 * 4. A form-wide failure additionally renders in the form, because a message
 *    that fades is a poor record of why a submission was rejected.
 */
export function planRouting(
  failure: AppFailure,
  index: FieldPathIndex | null,
  asFormError: boolean,
  allowToast = true,
): RoutingPlan {
  if (isSessionExpiry(failure)) {
    return { fieldErrors: new Map(), toast: false, toastDetail: null, form: true };
  }

  const resolved = index === null ? null : resolveDetails(failure.details, index);

  if (resolved !== null && resolved.mapped.size > 0) {
    return {
      fieldErrors: resolved.mapped,
      toast: allowToast,
      toastDetail: summarise(resolved.mapped.size, countAffectedPaths(resolved.unmapped)),
      form: asFormError,
    };
  }

  return { fieldErrors: new Map(), toast: allowToast, toastDetail: null, form: asFormError };
}

/** Carry out a plan. */
function route(
  failure: AppFailure,
  handlers: {
    fields?: (() => FieldPathIndex) | undefined;
    onFieldErrors?: ((byId: Map<string, string[]>) => void) | undefined;
    asFormError: boolean;
    allowToast: boolean;
    setFormError: (failure: AppFailure | null) => void;
    onFailureAction?: { label: string; onClick: (failure: AppFailure) => void } | undefined;
  },
): void {
  const { fields, onFieldErrors, asFormError, allowToast, setFormError, onFailureAction } =
    handlers;
  const plan = planRouting(failure, fields?.() ?? null, asFormError, allowToast);

  if (plan.fieldErrors.size > 0) {
    onFieldErrors?.(plan.fieldErrors);
  }
  if (plan.form) {
    setFormError(failure);
  }
  if (plan.toast) {
    notifyFailure(
      plan.toastDetail === null ? failure : { ...failure, detail: plan.toastDetail },
      buildAction(failure, onFailureAction),
    );
  }
}

function buildAction(
  failure: AppFailure,
  action: { label: string; onClick: (failure: AppFailure) => void } | undefined,
): { action: { label: string; onClick: () => void } } | Record<string, never> {
  if (action === undefined) {
    return {};
  }
  return { action: { label: action.label, onClick: () => action.onClick(failure) } };
}

/**
 * The toast's second line once detail has been routed.
 *
 * Counts what is on screen separately from what is not. Folding an unmappable
 * issue into the inline count would leave the user fixing two highlighted fields
 * and unable to work out why a third failure persists — so anything with no
 * inline home is stated as remaining.
 *
 * `unmappedPaths` is counted from the unmapped set rather than derived by
 * subtracting fields from paths: those are different units, and three rules
 * rejecting one field is one field to fix, not one plus two others.
 */
function summarise(fieldCount: number, unmappedPaths: number): string {
  const inline =
    fieldCount === 1 ? '1 field needs attention.' : `${fieldCount} fields need attention.`;
  if (unmappedPaths === 0) {
    return inline;
  }
  return `${inline} ${unmappedPaths} other issue${unmappedPaths === 1 ? '' : 's'}.`;
}

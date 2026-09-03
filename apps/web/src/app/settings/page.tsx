'use client';

/**
 * S8 · Settings (doc 11): account, display name, plan overview, theme.
 *
 * The plan limits are **served**, not hardcoded here. This page used to carry its
 * own copy of the table, which drifts from `packages/config` the first time a
 * limit changes — and `apps/web` cannot import that package, so a local copy was
 * the only alternative until `/v1/me` started returning them.
 * Billing/plan changes arrive with the billing integration (post-V1 wiring).
 */

import { useEffect, useId, useState } from 'react';
import { Button, Card, Field, FormError, Input, Select, StatusChip } from '@instantmockapi/ui';
import { useChangePassword, useMe, useUpdateMe } from '../../lib/hooks';
import { passwordProblems } from '../../lib/password';
import { useAction } from '../../lib/use-action';
import {
  readToastPosition,
  writeToastPosition,
  TOAST_POSITION_LABELS,
  TOAST_POSITIONS,
  DEFAULT_TOAST_POSITION,
  type ToastPosition,
} from '../../lib/toast-position';
import { notifyInfo } from '../../lib/toast';
import { PasswordField } from '../../components/auth/password-field';

const THEME_KEY = 'instantmockapi.theme';

/** `null` means unlimited on the wire — both server-side sentinels normalise to it. */
function limitText(limit: number | null, noun: string): string {
  return limit === null ? `Unlimited ${noun}` : `${limit} ${noun}`;
}

/**
 * Change the password.
 *
 * Requires the current one even though the session is already authenticated —
 * that is what stops someone at a borrowed laptop from taking the account. The
 * API bumps `tokenVersion` on success, which signs out every *other* device; this
 * session survives because the response carries a replacement.
 */
function ChangePasswordCard() {
  const change = useChangePassword();
  const currentId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const problems = passwordProblems(next);
  const nextError = submitted && problems.length > 0 ? (problems[0] ?? null) : null;

  /**
   * Form-wide, because the reason is about the submission rather than one input.
   *
   * A wrong current password is the common case and it *is* field-specific — but
   * the server answers with an unauthorized code and no path, so there is
   * nothing to route it by. Guessing would risk marking the new-password field
   * for a problem with the old one.
   */
  const action = useAction(change, {
    success: 'Password changed. Every other device has been signed out.',
    formError: true,
  });
  const pending = action.isPending;

  return (
    <Card className="ui-stack">
      <h2>Password</h2>
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (problems.length > 0) {
            return;
          }
          void action.run({ currentPassword: current, newPassword: next }).then((result) => {
            if (result !== null) {
              // Cleared on success so the fields are not left holding two live
              // passwords in the DOM.
              setCurrent('');
              setNext('');
              setSubmitted(false);
            }
          });
        }}
      >
        {action.formError ? (
          <FormError title={action.formError.title} detail={action.formError.detail} />
        ) : null}
        <Field label="Current password" htmlFor={currentId}>
          <Input
            id={currentId}
            type="password"
            name="current-password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            disabled={pending}
          />
        </Field>

        <PasswordField
          label="New password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          showRules
          disabled={pending}
          error={nextError}
        />

        <div className="ui-row">
          <Button size="sm" type="submit" disabled={pending || current === '' || next === ''}>
            {pending ? 'Changing…' : 'Change password'}
          </Button>
          <span className="ui-meta">Signs out every other device.</span>
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const me = useMe();
  const saveName = useAction(useUpdateMe(), { success: 'Display name saved' });
  const [theme, setTheme] = useState('dark');
  const [toastPosition, setToastPosition] = useState<ToastPosition>(DEFAULT_TOAST_POSITION);
  const [name, setName] = useState('');
  const [nameLoaded, setNameLoaded] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY) ?? 'dark';
    setTheme(stored);
    setToastPosition(readToastPosition());
  }, []);

  // Seed the field once, then leave it alone — re-syncing on every refetch would
  // discard whatever the user is part-way through typing.
  useEffect(() => {
    if (me.data && !nameLoaded) {
      setName(me.data.name ?? '');
      setNameLoaded(true);
    }
  }, [me.data, nameLoaded]);

  function applyToastPosition(next: ToastPosition) {
    setToastPosition(next);
    // Written and announced together, so the viewport moves now rather than on
    // the next reload — and the sample below is what proves it moved.
    writeToastPosition(next);
    notifyInfo(
      'Notifications appear here',
      TOAST_POSITION_LABELS[next],
      // One key, so changing the setting repeatedly moves a single sample
      // instead of stacking one per click.
      'toast-position-sample',
    );
  }

  function applyTheme(next: string) {
    setTheme(next);
    window.localStorage.setItem(THEME_KEY, next);
    document.documentElement.setAttribute('data-theme', next);
  }

  const limits = me.data?.limits;

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: 560 }}>
      <h1>Settings</h1>

      <Card className="ui-stack">
        <h2>Account</h2>
        <div className="ui-row ui-row--between">
          <span className="ui-mono">{me.data?.email ?? '…'}</span>
          {me.data ? <StatusChip status="active" label={`${me.data.plan} plan`} /> : null}
        </div>

        <Field label="Display name">
          <Input
            value={name}
            placeholder="Your name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="ui-row">
          <Button
            size="sm"
            disabled={saveName.isPending || !nameLoaded || name === (me.data?.name ?? '')}
            onClick={() => void saveName.run({ name: name.trim() === '' ? null : name.trim() })}
          >
            {saveName.isPending ? 'Saving…' : 'Save'}
          </Button>
          {<span className="ui-meta">Used to greet you on the dashboard.</span>}
        </div>

        {limits ? (
          <ul className="ui-meta" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            <li>Hosted API lifetime: {limits.hostedApiLifetimeDays} days</li>
            <li>{limitText(limits.maxConcurrentJobs, 'concurrent jobs')}</li>
            <li>{limitText(limits.maxProjects, 'projects')}</li>
          </ul>
        ) : null}
      </Card>

      <ChangePasswordCard />

      <Card className="ui-stack">
        <h2>Appearance</h2>
        <Field label="Theme">
          <Select value={theme} onChange={(event) => applyTheme(event.target.value)}>
            <option value="dark">Dark (default)</option>
            <option value="light">Light</option>
          </Select>
        </Field>
      </Card>

      <Card className="ui-stack">
        <h2>Notifications</h2>
        <Field
          label="Position"
          hint="Where confirmations and errors appear. One place, on every screen."
        >
          <Select
            value={toastPosition}
            aria-label="Notification position"
            onChange={(event) => applyToastPosition(event.target.value as ToastPosition)}
          >
            {TOAST_POSITIONS.map((position) => (
              <option key={position} value={position}>
                {TOAST_POSITION_LABELS[position]}
                {position === DEFAULT_TOAST_POSITION ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {/*
          Changing the control shows a sample immediately. A position setting
          whose effect is invisible until the next failure is one nobody can tell
          they have set correctly.
        */}
        <p className="ui-meta">
          Errors stay until you dismiss them; confirmations fade on their own.
        </p>
      </Card>
    </div>
  );
}

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

import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select, StatusChip } from '@instantmockapi/ui';
import { useMe, useUpdateMe } from '../../lib/hooks';

const THEME_KEY = 'instantmockapi.theme';

/** `null` means unlimited on the wire — both server-side sentinels normalise to it. */
function limitText(limit: number | null, noun: string): string {
  return limit === null ? `Unlimited ${noun}` : `${limit} ${noun}`;
}

export default function SettingsPage() {
  const me = useMe();
  const updateMe = useUpdateMe();
  const [theme, setTheme] = useState('dark');
  const [name, setName] = useState('');
  const [nameLoaded, setNameLoaded] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY) ?? 'dark';
    setTheme(stored);
  }, []);

  // Seed the field once, then leave it alone — re-syncing on every refetch would
  // discard whatever the user is part-way through typing.
  useEffect(() => {
    if (me.data && !nameLoaded) {
      setName(me.data.name ?? '');
      setNameLoaded(true);
    }
  }, [me.data, nameLoaded]);

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
            disabled={updateMe.isPending || !nameLoaded || name === (me.data?.name ?? '')}
            onClick={() => updateMe.mutate({ name: name.trim() === '' ? null : name.trim() })}
          >
            {updateMe.isPending ? 'Saving…' : 'Save'}
          </Button>
          {updateMe.isError ? (
            <span className="ui-error">{updateMe.error.message}</span>
          ) : (
            <span className="ui-meta">Used to greet you on the dashboard.</span>
          )}
        </div>

        {limits ? (
          <ul className="ui-meta" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            <li>Hosted API lifetime: {limits.hostedApiLifetimeDays} days</li>
            <li>{limitText(limits.maxConcurrentJobs, 'concurrent jobs')}</li>
            <li>{limitText(limits.maxProjects, 'projects')}</li>
          </ul>
        ) : null}
      </Card>

      <Card className="ui-stack">
        <h2>Appearance</h2>
        <Field label="Theme">
          <Select value={theme} onChange={(event) => applyTheme(event.target.value)}>
            <option value="dark">Dark (default)</option>
            <option value="light">Light</option>
          </Select>
        </Field>
      </Card>
    </div>
  );
}

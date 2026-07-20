'use client';

/**
 * S8 · Settings (doc 11): account + plan overview and theme preference.
 * Billing/plan changes arrive with the billing integration (post-V1 wiring).
 */

import { useEffect, useState } from 'react';
import { Card, Field, Select, StatusChip } from '@instantmockapi/ui';
import { useMe } from '../../lib/hooks';

const THEME_KEY = 'instantmockapi.theme';
const PLAN_LIMITS: Record<string, { lifetime: string; jobs: string; projects: string }> = {
  free: { lifetime: '2 days', jobs: '1 concurrent job', projects: '10 projects' },
  pro: { lifetime: '7 days', jobs: '3 concurrent jobs', projects: '100 projects' },
  enterprise: { lifetime: '30 days', jobs: 'Unlimited jobs', projects: 'Unlimited projects' },
};

export default function SettingsPage() {
  const me = useMe();
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY) ?? 'dark';
    setTheme(stored);
  }, []);

  function applyTheme(next: string) {
    setTheme(next);
    window.localStorage.setItem(THEME_KEY, next);
    document.documentElement.setAttribute('data-theme', next);
  }

  const limits = PLAN_LIMITS[me.data?.plan ?? 'free'];

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: 560 }}>
      <h1>Settings</h1>

      <Card className="ui-stack">
        <h2>Account</h2>
        <div className="ui-row ui-row--between">
          <span className="ui-mono">{me.data?.email ?? '…'}</span>
          {me.data ? <StatusChip status="active" label={`${me.data.plan} plan`} /> : null}
        </div>
        {limits ? (
          <ul className="ui-meta" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            <li>Hosted API lifetime: {limits.lifetime}</li>
            <li>{limits.jobs}</li>
            <li>{limits.projects}</li>
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

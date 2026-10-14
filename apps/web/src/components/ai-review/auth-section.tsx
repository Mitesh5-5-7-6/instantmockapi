'use client';

import type { Dispatch } from 'react';
import { Card } from '@instantmockapi/ui';
import { AuthStep } from '../builder/auth-step';
import { PROJECT_CHOICES, SIMPLE_CHOICES } from '../../lib/auth-onboarding';
import type { ReviewAction, ReviewState } from '../../lib/review-state';

/** "Always ask": nothing is pre-selected; the AI's view is only a hint (SP2 D6). */
export function AuthSection({
  state,
  dispatch,
  recommendation,
}: {
  state: ReviewState;
  dispatch: Dispatch<ReviewAction>;
  recommendation: { recommended: boolean; reason: string };
}) {
  const named = state.entities.filter((entity) => entity.name.trim());
  return (
    <Card className="ui-stack">
      <h2>Does this API require authentication?</h2>
      <p className="ui-meta">
        Suggested: {recommendation.recommended ? 'yes' : 'no'}
        {recommendation.reason ? ` — ${recommendation.reason}` : ''}. You decide.
      </p>
      <AuthStep
        choices={state.kind === 'single' ? SIMPLE_CHOICES : PROJECT_CHOICES}
        mode={state.authMode}
        onMode={(mode) => dispatch({ type: 'authMode', value: mode })}
        entities={named}
        protectedNames={state.protectedNames}
        onToggleEntity={(name) => dispatch({ type: 'toggleProtected', name })}
        methods={state.methods}
        showEntityPicker={state.kind !== 'single'}
      />
    </Card>
  );
}

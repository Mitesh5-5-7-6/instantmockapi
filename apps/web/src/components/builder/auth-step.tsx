'use client';

/**
 * The wizard's authentication question (Phase 3 §1, §2).
 *
 * Shared by both flows because the *question* is the same even though the
 * options are not: the Single API wizard passes `SIMPLE_CHOICES` (§1's bare
 * yes/no) and the Project API wizard passes `PROJECT_CHOICES` (§2's three-way).
 * One component so the copy, the endpoint preview and the warning cannot drift
 * between the two places a user first meets this.
 *
 * ## The preview is the teaching, not the radio buttons
 *
 * "Everything needs a login" is an abstraction. `GET /orders 🔒` sitting next to
 * `POST /signIn` is the thing itself, and it is what makes the generated API
 * unsurprising when it arrives. Every rule behind it lives in
 * `lib/auth-onboarding.ts`, which is testable; this renders.
 */

import { Badge, Card, Checkbox, Icon, Note } from '@instantmockapi/ui';
import type { AuthMode } from '../../lib/api-types';
import {
  describeChoice,
  emptySelectionWarning,
  previewEndpoints,
  type AuthChoice,
} from '../../lib/auth-onboarding';

export interface AuthStepProps {
  /** §1's two options, or §2's three. */
  choices: readonly AuthChoice[];
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  /** Entity names, in the order the model declares them. */
  entities: readonly { name: string }[];
  /** Which entities the user has marked as needing a login. */
  protectedNames: readonly string[];
  onToggleEntity: (name: string) => void;
  /** The methods this project will route, so the preview matches reality. */
  methods: readonly string[];
  /** Single API flows have one resource and no per-entity list to show. */
  showEntityPicker?: boolean;
}

export function AuthStep({
  choices,
  mode,
  onMode,
  entities,
  protectedNames,
  onToggleEntity,
  methods,
  showEntityPicker = true,
}: AuthStepProps) {
  const named = entities.filter((entity) => entity.name.trim() !== '');
  const preview = previewEndpoints({
    mode,
    entities: named,
    protectedNames,
    methods,
    // The wizard always generates the full Auth API; turning individual
    // endpoints off is an Auth-tab refinement, not a first-run decision.
    signup: true,
    refreshToken: true,
  });
  const warning = emptySelectionWarning(mode, protectedNames.length);

  return (
    <Card className="ui-stack">
      <div className="ui-stack ui-stack--tight">
        <h2>Who can call this API?</h2>
        <p className="ui-meta">
          Right now anyone with the URL could. If your app has users who sign in, the mock API can
          work the same way — and you can change this at any time on the project&rsquo;s Auth tab.
        </p>
      </div>

      <fieldset className="ui-stack" style={{ gap: 'var(--space-3)' }}>
        <legend className="ui-visually-hidden">Authentication</legend>
        {choices.map((choice) => (
          <label
            key={choice.mode}
            className="ui-row"
            style={{ alignItems: 'flex-start', gap: 'var(--space-3)', cursor: 'pointer' }}
          >
            <input
              type="radio"
              name="wizard-auth"
              checked={mode === choice.mode}
              onChange={() => onMode(choice.mode)}
              style={{ marginTop: '0.25rem' }}
            />
            <span className="ui-stack" style={{ gap: 'var(--space-1)' }}>
              <span>{choice.label}</span>
              <span className="ui-meta">{choice.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Only for the per-entity answer. Shown for the others would be a list
          of disabled checkboxes explaining that the choice above already
          decided — noise on the screen where the concept is being introduced. */}
      {mode === 'COMBINATION' && showEntityPicker && named.length > 0 ? (
        <div className="ui-stack ui-stack--tight">
          <h3>Which of these need a login?</h3>
          <p className="ui-meta">
            All of an entity&rsquo;s methods share its setting — reading, creating, updating and
            deleting together.
          </p>
          <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
            {named.map((entity) => (
              <Checkbox
                key={entity.name}
                checked={protectedNames.includes(entity.name)}
                label={entity.name}
                onChange={() => onToggleEntity(entity.name)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {warning !== null ? <Note variant="warning">{warning}</Note> : null}

      {/* §1's "show a proper endpoints": the answer made concrete. */}
      <div className="ui-stack ui-stack--tight">
        <h3>What you will get</h3>
        <p className="ui-meta">{describeChoice(mode, protectedNames.length, named.length)}</p>
        <ul className="ui-stack" style={{ gap: 'var(--space-1)', listStyle: 'none', padding: 0 }}>
          {preview.map((endpoint) => (
            <li
              key={`${endpoint.method} ${endpoint.path}`}
              className="ui-row"
              style={{ gap: 'var(--space-2)' }}
            >
              <span className="ui-meta ui-mono" style={{ minWidth: '4rem' }}>
                {endpoint.method}
              </span>
              <span className="ui-mono">{endpoint.path}</span>
              {endpoint.requiresAuth ? (
                // A bordered badge with a word, not a coloured row: a
                // twenty-endpoint list would otherwise be a wall of colour, and
                // the lock has to survive greyscale and a screen reader.
                <Badge variant="neutral">
                  <Icon name="lock" size={14} /> Needs login
                </Badge>
              ) : null}
              {endpoint.isAuthApi ? <Badge variant="accent">Auth</Badge> : null}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

'use client';

/**
 * A password input with a visibility toggle, and optionally the rules checklist.
 *
 * The toggle is not a nicety. Typing a long passphrase blind is the main reason
 * people pick short ones, and "confirm password" fields exist only because the
 * first one is masked — showing the value removes the need for both.
 */

import { useId, useState } from 'react';
import { Field, Icon, Input } from '@instantmockapi/ui';
import {
  passwordRules,
  passwordStrength,
  strengthFraction,
  type PasswordStrength,
} from '../../lib/password';

const STRENGTH_LABEL: Record<PasswordStrength, string> = {
  empty: '',
  weak: 'Too weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  email,
  showRules = false,
  disabled,
  autoFocus,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * `current-password` on sign-in, `new-password` everywhere a password is being
   * set. Getting this wrong is why password managers offer to save the wrong
   * thing, or offer nothing at all.
   */
  autoComplete: 'current-password' | 'new-password';
  /** Used only to warn against a password derived from the address. */
  email?: string;
  /** Show the requirements checklist and strength meter. */
  showRules?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  error?: string | null;
  hint?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const rules = showRules ? passwordRules(value, email) : [];
  const strength = passwordStrength(value, email);

  return (
    <Field
      label={label}
      htmlFor={id}
      {...(error !== undefined ? { error } : {})}
      {...(hint !== undefined ? { hint } : {})}
    >
      <div className="auth-password">
        <Input
          id={id}
          name={autoComplete === 'current-password' ? 'password' : 'new-password'}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoFocus={autoFocus}
          // Announces the rules list as the field's description, so a screen
          // reader hears the requirements rather than only the label.
          aria-describedby={showRules ? `${id}-rules` : undefined}
        />
        <button
          type="button"
          className="auth-password__toggle"
          onClick={() => setVisible((current) => !current)}
          // Named for what pressing it does, not for the current state — the
          // latter reads as a status announcement and leaves the user unsure
          // what the button will do.
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          disabled={disabled}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={16} />
        </button>
      </div>

      {showRules ? (
        <div className="auth-strength" id={`${id}-rules`}>
          <div className="auth-strength__bar" data-strength={strength}>
            <span style={{ width: `${strengthFraction(strength) * 100}%` }} />
          </div>
          {/* Polite, not assertive: the meter updates on every keystroke and an
              assertive region would interrupt continuously. */}
          <p className="auth-strength__label" aria-live="polite">
            {STRENGTH_LABEL[strength]}
          </p>
          <ul className="auth-rules">
            {rules.map((rule) => (
              <li key={rule.label} data-met={rule.met ? 'true' : 'false'}>
                {/* The icon changes shape, not just colour — so the state is
                    readable in monochrome and to a colour-blind reader. */}
                <Icon name={rule.met ? 'check' : 'x'} size={14} />
                {rule.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Field>
  );
}

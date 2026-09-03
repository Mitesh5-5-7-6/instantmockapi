'use client';

/**
 * Create an account (doc 13 §7.2).
 *
 * The requirements are shown from the start rather than after a rejection: a
 * rule you learn by breaking it is a rule you had to guess. Validation happens
 * here *and* on the API — this copy exists to save a round trip, not to be
 * trusted.
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormError, Button, Field, Input } from '@instantmockapi/ui';
import { normalizeError } from '../../lib/errors';
import { useAuthState, useResendVerification, useSignup } from '../../lib/hooks';
import { passwordProblems } from '../../lib/password';
import { AuthCard, AuthNotice } from '../../components/auth/auth-card';
import { PasswordField } from '../../components/auth/password-field';
import {
  AuthDivider,
  GoogleButton,
  googleSignInConfigured,
} from '../../components/auth/google-button';

export default function SignupPage() {
  const router = useRouter();
  const authState = useAuthState();
  const nameId = useId();
  const emailId = useId();
  const signup = useSignup();
  const resend = useResendVerification();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (authState === 'authenticated') {
      router.replace('/');
    }
  }, [authState, router]);

  const failure = signup.isError ? normalizeError(signup.error) : null;
  // The account exists and only the email failed, so this is the one failure
  // with a useful next action rather than just a message.
  const emailFailed = failure?.code === 'EMAIL_SEND_FAILED';

  const problems = passwordProblems(password, email);
  // Only after a submit attempt: flagging a half-typed password as too short on
  // the third keystroke is noise, and the checklist already shows the rules.
  const passwordError = submitted && problems.length > 0 ? (problems[0] ?? null) : null;
  const pending = signup.isPending;

  if (signup.isSuccess) {
    return (
      <AuthCard
        title="Check your inbox"
        footer={
          <>
            Wrong address? <Link href="/signup">Start again</Link>
          </>
        }
      >
        {/* The form is gone, not merely annotated: after a successful submit it
            is no longer the thing to interact with, and leaving it invites a
            second submission that the rate limit will refuse. */}
        <AuthNotice icon="mail" title={`We have emailed ${email}`}>
          <p className="ui-meta">{signup.data.message}</p>
          <p className="ui-meta">
            The link works once and expires in 24 hours. You cannot sign in until it is used.
          </p>
        </AuthNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="No credit card. Free plan includes 3 projects."
      footer={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      {googleSignInConfigured() ? (
        <>
          <GoogleButton label="Sign up with Google" disabled={pending} />
          <AuthDivider />
        </>
      ) : null}

      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (problems.length > 0) {
            return;
          }
          signup.mutate({ email, password, ...(name.trim() !== '' ? { name: name.trim() } : {}) });
        }}
      >
        <Field label="Name" htmlFor={nameId} hint="Optional — used to address emails to you.">
          <Input
            id={nameId}
            name="name"
            autoComplete="name"
            maxLength={80}
            autoFocus
            placeholder="Ada Lovelace"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
          />
        </Field>

        <Field label="Email" htmlFor={emailId}>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
          />
        </Field>

        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          email={email}
          showRules
          disabled={pending}
          error={passwordError}
        />

        <Button type="submit" disabled={pending}>
          {pending ? 'Creating your account…' : 'Create account'}
        </Button>

        {failure !== null && !emailFailed ? (
          <FormError title={failure.title} detail={failure.detail} />
        ) : null}

        {/* The retry lives here, next to the address that was just typed. An
            earlier version of the API message sent people to the sign-in page
            for a "Resend the link" control that only appears there *after* a
            rejected login — instructions to somewhere they were not. */}
        {emailFailed ? (
          <AuthNotice tone="warning" icon="alert" title="We could not send the confirmation email">
            <p className="ui-meta">{failure?.title} Your password is saved — nothing is lost.</p>
            {resend.isSuccess ? (
              <p className="ui-meta">{resend.data.message}</p>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => resend.mutate(email)}
                  disabled={resend.isPending}
                >
                  {resend.isPending ? 'Sending…' : 'Resend the link'}
                </Button>
                {/* Honest about the limit: this endpoint answers the same way
                    whether or not the send worked (it has to — see
                    resendVerification in auth-service.ts), so a second failure
                    would look like a success. Better to say so than to imply
                    the button proves anything. */}
                <p className="ui-meta">
                  If it fails again the problem is on our side. You can also sign in later — the
                  sign-in page will offer the link again.
                </p>
              </>
            )}
          </AuthNotice>
        ) : null}
      </form>
    </AuthCard>
  );
}

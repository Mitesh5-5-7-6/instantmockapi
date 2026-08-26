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
import { Button, Field, Input } from '@instantmockapi/ui';
import { ApiError } from '../../lib/api-client';
import { useAuthState, useSignup } from '../../lib/hooks';
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
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (authState === 'authenticated') {
      router.replace('/');
    }
  }, [authState, router]);

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

        {signup.error instanceof ApiError ? (
          <p className="ui-error" role="alert">
            {signup.error.message}
          </p>
        ) : null}
      </form>
    </AuthCard>
  );
}

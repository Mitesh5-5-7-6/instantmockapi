'use client';

/**
 * Sign in (doc 13 §7.2).
 *
 * Replaces the email-only card that used to render inside `AppShell`: on the
 * deployed app, typing an address *was* signing in as its owner. This one takes a
 * password, and the API refuses an unverified address.
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@instantmockapi/ui';
import { ApiError } from '../../lib/api-client';
import { useAuthState, useLogin, useResendVerification } from '../../lib/hooks';
import { AuthCard, AuthNotice } from '../../components/auth/auth-card';
import { PasswordField } from '../../components/auth/password-field';
import {
  AuthDivider,
  GoogleButton,
  googleSignInConfigured,
} from '../../components/auth/google-button';

export default function LoginPage() {
  const router = useRouter();
  const authState = useAuthState();
  const emailId = useId();
  const login = useLogin();
  const resend = useResendVerification();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Someone already signed in has no business on this page — arriving here from
  // a bookmark should land them in the app, not on a form.
  useEffect(() => {
    if (authState === 'authenticated') {
      router.replace('/');
    }
  }, [authState, router]);

  const error = login.error instanceof ApiError ? login.error : null;
  const unverified = error?.code === 'EMAIL_NOT_VERIFIED';
  const pending = login.isPending;

  if (login.data?.kind === 'password-setup-required') {
    return (
      <AuthCard title="Check your inbox">
        <AuthNotice icon="mail" title="We have emailed you a link to set a password">
          <p className="ui-meta">{login.data.message}</p>
          <p className="ui-meta">
            This account was created before passwords existed, or through Google. Setting one lets
            you sign in with your email address as well.
          </p>
        </AuthNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Turn a schema into a working backend in minutes."
      footer={
        <>
          New here? <Link href="/signup">Create an account</Link>
        </>
      }
    >
      {googleSignInConfigured() ? (
        <>
          <GoogleButton disabled={pending} />
          <AuthDivider />
        </>
      ) : null}

      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ email, password });
        }}
      >
        <Field label="Email" htmlFor={emailId}>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            // The input is disabled too, not just the button: a field that
            // still accepts typing during a submit invites a second edit that
            // will not be sent.
            disabled={pending}
          />
        </Field>

        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={pending}
        />

        <div className="auth-row">
          <Link href="/forgot-password">Forgot your password?</Link>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>

        {error !== null && !unverified ? (
          <p className="ui-error" role="alert">
            {error.message}
          </p>
        ) : null}

        {/* Its own branch, because this is not really an error: the password was
            right and there is something useful to do about it. */}
        {unverified ? (
          <AuthNotice tone="warning" icon="alert" title="Confirm your email address first">
            <p className="ui-meta">{error?.message}</p>
            {resend.isSuccess ? (
              <p className="ui-meta">{resend.data.message}</p>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => resend.mutate(email)}
                disabled={resend.isPending}
              >
                {resend.isPending ? 'Sending…' : 'Resend the link'}
              </Button>
            )}
          </AuthNotice>
        ) : null}
      </form>
    </AuthCard>
  );
}

'use client';

/**
 * Redeem a reset or set-password link (doc 13 §5).
 *
 * One page for both, because by the time the link is clicked the action is
 * identical — only the email that sent it differed. Redeeming signs the user in,
 * and the API has bumped `tokenVersion`, so every other session is already dead.
 */

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@instantmockapi/ui';
import { ApiError } from '../../lib/api-client';
import { useResetPassword } from '../../lib/hooks';
import { passwordProblems } from '../../lib/password';
import { AuthCard, AuthNotice } from '../../components/auth/auth-card';
import { PasswordField } from '../../components/auth/password-field';

function ResetPasswordForm() {
  const router = useRouter();
  // useSearchParams needs a Suspense boundary in the App Router — the same
  // requirement /projects already hit for its ?q= parameter.
  const token = useSearchParams().get('token') ?? '';
  const reset = useResetPassword();
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);

  // Checked before anything is rendered: a visitor who arrived without a token
  // has nothing to fill in, and a form that cannot succeed should not be shown.
  if (token === '') {
    return (
      <AuthCard
        title="This link is incomplete"
        footer={
          <>
            <Link href="/forgot-password">Request a new link</Link>
          </>
        }
      >
        <AuthNotice tone="warning" icon="alert" title="No reset token in the address">
          <p className="ui-meta">
            Email clients sometimes truncate long links. Copying the whole line from the email
            usually fixes it.
          </p>
        </AuthNotice>
      </AuthCard>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthCard title="Your password is set">
        <AuthNotice tone="success" icon="check" title="You are signed in">
          <p className="ui-meta">
            Any other device that was signed in has been signed out — including anyone who should
            not have been there.
          </p>
        </AuthNotice>
        <Button type="button" onClick={() => router.replace('/')}>
          Go to your dashboard
        </Button>
      </AuthCard>
    );
  }

  const problems = passwordProblems(password);
  const passwordError = submitted && problems.length > 0 ? (problems[0] ?? null) : null;

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="Setting it signs you in and signs out every other session."
    >
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (problems.length > 0) {
            return;
          }
          reset.mutate({ token, password });
        }}
      >
        <PasswordField
          label="New password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          showRules
          autoFocus
          disabled={reset.isPending}
          error={passwordError}
        />

        <Button type="submit" disabled={reset.isPending}>
          {reset.isPending ? 'Saving…' : 'Set password and sign in'}
        </Button>

        {reset.error instanceof ApiError ? (
          <>
            <p className="ui-error" role="alert">
              {reset.error.message}
            </p>
            <p className="ui-meta">
              <Link href="/forgot-password">Request a new link</Link>
            </p>
          </>
        ) : null}
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCard title="Choose a new password">{null}</AuthCard>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

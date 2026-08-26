'use client';

/**
 * Request a password-reset link (doc 13 §5.1).
 *
 * The API answers identically whether or not the address has an account, and so
 * does this page. There is deliberately nothing here that could tell a visitor
 * which addresses are registered — that is what would make the form an
 * account-existence oracle.
 */

import { useId, useState } from 'react';
import Link from 'next/link';
import { Button, Field, Input } from '@instantmockapi/ui';
import { ApiError } from '../../lib/api-client';
import { useForgotPassword } from '../../lib/hooks';
import { AuthCard, AuthNotice } from '../../components/auth/auth-card';

export default function ForgotPasswordPage() {
  const emailId = useId();
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');

  if (forgot.isSuccess) {
    return (
      <AuthCard
        title="Check your inbox"
        footer={
          <>
            <Link href="/login">Back to sign in</Link>
          </>
        }
      >
        <AuthNotice icon="mail" title={`If ${email} has an account, the link is on its way`}>
          {/* "If" is doing real work in that sentence. Saying "we have sent you
              a link" would confirm the account exists. */}
          <p className="ui-meta">{forgot.data.message}</p>
          <p className="ui-meta">The link works once and expires in an hour.</p>
        </AuthNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your email address and we will send you a link."
      footer={
        <>
          Remembered it? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault();
          forgot.mutate(email);
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
            disabled={forgot.isPending}
          />
        </Field>

        <Button type="submit" disabled={forgot.isPending}>
          {forgot.isPending ? 'Sending…' : 'Send the link'}
        </Button>

        {forgot.error instanceof ApiError ? (
          <p className="ui-error" role="alert">
            {forgot.error.message}
          </p>
        ) : null}
      </form>
    </AuthCard>
  );
}

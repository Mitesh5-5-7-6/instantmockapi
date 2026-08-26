'use client';

/**
 * Redeem an emailed verification link (doc 13 §5).
 *
 * Submits on mount rather than asking for a click. The click already happened —
 * in the email — and a second "confirm" button here is a step that exists only
 * because the page was built around a form.
 *
 * Note the deliberate consequence: a mail client that prefetches the link will
 * spend the token, and the user then arrives to find it used. That is why the API
 * redeems atomically and why the failure state below offers a resend rather than
 * a dead end.
 */

import { Suspense, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@instantmockapi/ui';
import { ApiError } from '../../lib/api-client';
import { useVerifyEmail } from '../../lib/hooks';
import { AuthCard, AuthNotice } from '../../components/auth/auth-card';

function VerifyEmailInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const verify = useVerifyEmail();
  // Guards against React's development double-invoke and against any re-render
  // re-firing the mutation: the token is single-use, so a second attempt would
  // turn a success into "this link has already been used".
  const attempted = useRef(false);

  useEffect(() => {
    if (token === '' || attempted.current) {
      return;
    }
    attempted.current = true;
    verify.mutate(token);
  }, [token, verify]);

  if (token === '') {
    return (
      <AuthCard
        title="This link is incomplete"
        footer={
          <>
            <Link href="/login">Back to sign in</Link>
          </>
        }
      >
        <AuthNotice tone="warning" icon="alert" title="No confirmation token in the address">
          <p className="ui-meta">
            Email clients sometimes truncate long links. Copying the whole line from the email
            usually fixes it.
          </p>
        </AuthNotice>
      </AuthCard>
    );
  }

  if (verify.isSuccess) {
    return (
      <AuthCard title="Your address is confirmed">
        <AuthNotice tone="success" icon="check" title={`Signed in as ${verify.data.email}`}>
          <p className="ui-meta">Your account is ready.</p>
        </AuthNotice>
        <Button type="button" onClick={() => router.replace('/')}>
          Go to your dashboard
        </Button>
      </AuthCard>
    );
  }

  if (verify.isError) {
    return (
      <AuthCard
        title="That link no longer works"
        footer={
          <>
            <Link href="/login">Back to sign in</Link>
          </>
        }
      >
        <AuthNotice tone="warning" icon="alert" title="The link has expired or was already used">
          <p className="ui-meta">
            {verify.error instanceof ApiError ? verify.error.message : 'Request a new one.'}
          </p>
          <p className="ui-meta">Signing in will offer to send a fresh confirmation link.</p>
        </AuthNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Confirming your email address">
      <p className="ui-meta" aria-live="polite">
        One moment…
      </p>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthCard title="Confirming your email address">{null}</AuthCard>}>
      <VerifyEmailInner />
    </Suspense>
  );
}

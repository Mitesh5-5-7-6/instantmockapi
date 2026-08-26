'use client';

/**
 * The Google OAuth callback (doc 13 §6).
 *
 * A **client** page, not a server route handler: `apps/web` has none — no
 * `route.ts`, no `app/api/` — and adding a server surface for one redirect would
 * be the app's first. It does not need one, because the client secret never comes
 * near the browser: this page only forwards the code and the PKCE verifier to the
 * API, which does the exchange.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '../../../../lib/api-client';
import { useGoogleSignIn } from '../../../../lib/hooks';
import { googleRedirectUri, takeHandshake } from '../../../../lib/pkce';
import { AuthCard, AuthNotice } from '../../../../components/auth/auth-card';

function GoogleCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const signIn = useGoogleSignIn();
  const attempted = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (attempted.current) {
      return;
    }
    attempted.current = true;

    // Google's own refusal — the user pressed Cancel, or the app is
    // misconfigured. Reported as it is rather than mistaken for our own failure.
    const denied = params.get('error');
    if (denied !== null) {
      setProblem(
        denied === 'access_denied'
          ? 'Sign-in was cancelled.'
          : `Google refused the sign-in (${denied}).`,
      );
      return;
    }

    const code = params.get('code');
    const state = params.get('state');
    // Read-and-clear, so a replayed callback URL finds nothing.
    const handshake = takeHandshake();

    if (code === null || handshake === null) {
      setProblem('This sign-in could not be completed. Start again from the sign-in page.');
      return;
    }

    // The `state` check. Without it, an attacker can hand someone a callback URL
    // carrying the attacker's own code and sign the victim into the attacker's
    // account — where anything the victim then does is visible to them.
    if (state !== handshake.state) {
      setProblem('This sign-in could not be verified. Start again from the sign-in page.');
      return;
    }

    signIn.mutate(
      {
        code,
        codeVerifier: handshake.verifier,
        // Sent, and re-checked by Google against the one used to get the code —
        // so it has to be derived the same way here as it was before the redirect.
        redirectUri: googleRedirectUri(window.location.origin),
      },
      { onSuccess: () => router.replace(handshake.returnTo ?? '/') },
    );
  }, [params, router, signIn]);

  const message =
    problem ?? (signIn.error instanceof ApiError ? signIn.error.message : null) ?? null;

  if (message !== null) {
    return (
      <AuthCard
        title="Sign-in could not be completed"
        footer={
          <>
            <Link href="/login">Back to sign in</Link>
          </>
        }
      >
        <AuthNotice tone="warning" icon="alert" title="Nothing was changed">
          <p className="ui-meta">{message}</p>
        </AuthNotice>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Signing you in">
      <p className="ui-meta" aria-live="polite">
        One moment…
      </p>
    </AuthCard>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={<AuthCard title="Signing you in">{null}</AuthCard>}>
      <GoogleCallbackInner />
    </Suspense>
  );
}

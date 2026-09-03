'use client';

/**
 * "Continue with Google" — starts the PKCE handshake and leaves the page.
 *
 * Renders nothing when no client id is configured. That is the right behaviour
 * rather than a stub: a button that always fails is worse than no button, and a
 * developer with no Google credentials should see the email form alone.
 */

import { useState } from 'react';
import { Button, FormError, Icon } from '@instantmockapi/ui';
import {
  challengeFor,
  createVerifier,
  googleAuthorizeUrl,
  googleRedirectUri,
  randomState,
  rememberHandshake,
} from '../../lib/pkce';

export function googleSignInConfigured(): boolean {
  return (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '') !== '';
}

export function GoogleButton({
  label = 'Continue with Google',
  returnTo,
  disabled,
}: {
  label?: string;
  /** Where to land after a successful sign-in. */
  returnTo?: string;
  disabled?: boolean;
}) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);

  if (clientId === '') {
    return null;
  }

  const start = async (): Promise<void> => {
    setStarting(true);
    setFailed(false);
    try {
      const verifier = createVerifier();
      const state = randomState();
      // Stored *before* the redirect, and the redirect is the last thing that
      // happens — otherwise a slow write races a fast navigation and the callback
      // finds nothing.
      rememberHandshake({ verifier, state, returnTo: returnTo ?? null });
      const challenge = await challengeFor(verifier);
      window.location.assign(
        googleAuthorizeUrl({
          clientId,
          redirectUri: googleRedirectUri(window.location.origin),
          state,
          challenge,
        }),
      );
    } catch {
      // crypto.subtle is unavailable on an insecure origin. Say so rather than
      // leaving a button that spins forever.
      setStarting(false);
      setFailed(true);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => void start()}
        disabled={disabled || starting}
        className="auth-google"
      >
        <Icon name="google" size={16} />
        {starting ? 'Redirecting…' : label}
      </Button>
      {/*
        A FormError rather than a toast: this fires before any request is made —
        the browser refused to start the flow — and the alternative is the email
        form immediately below it.
      */}
      {failed ? (
        <FormError
          title="Could not start Google sign-in"
          detail="This browser blocked the redirect. Use your email address instead."
        />
      ) : null}
    </>
  );
}

/** "or" rule between the Google button and the email form. */
export function AuthDivider() {
  return (
    <div className="auth-divider" aria-hidden="true">
      <span>or</span>
    </div>
  );
}

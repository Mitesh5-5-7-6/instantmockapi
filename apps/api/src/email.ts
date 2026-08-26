/**
 * Email transport (doc 13 §1).
 *
 * Two implementations behind one interface:
 *
 * - **Resend**, a plain HTTPS POST. No SDK and no SMTP connection to hold open,
 *   which matters because this API runs as serverless functions — a socket-based
 *   mailer would have to connect, hand-shake and tear down on every invocation.
 * - **Log**, used automatically whenever no API key is configured. It prints the
 *   message, so local development can complete a signup by reading the link out
 *   of the terminal rather than needing a mail account.
 *
 * `assertProductionSecrets` refuses to boot production without a key, so the log
 * transport can never silently become the production one.
 */

import { logger } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import type { EmailMessage } from './email-templates.js';

export interface Mailer {
  /**
   * Deliver one message.
   *
   * Resolves on success and **throws on failure** — the caller decides whether a
   * failed send should fail the request. Sign-up does (the user must know their
   * link is not coming); a neutral endpoint like forgot-password does not, since
   * reporting it would leak whether the address exists.
   */
  send(message: EmailMessage): Promise<void>;
  /** Which transport this is, for logging and for tests. */
  readonly kind: 'resend' | 'log';
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Beyond this a mail API call is hung; better to fail the request than hold it. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Never log a whole email — the body contains a working verification or reset
 * token, and application logs are not a place to keep credentials.
 */
function redactedSubject(message: EmailMessage): Record<string, string> {
  return { to: message.to, subject: message.subject };
}

function createResendMailer(config: EnvConfig): Mailer {
  return {
    kind: 'resend',
    async send(message) {
      // AbortSignal.timeout rather than a manual controller + setTimeout: no
      // timer to forget to clear on the success path.
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Read the body for the reason — Resend explains rejections there, and
        // "422" alone is not enough to debug a bad from-address.
        const detail = await response.text().catch(() => '');
        logger.error('Email send failed', {
          ...redactedSubject(message),
          status: response.status,
          detail: detail.slice(0, 500),
        });
        throw new Error(`Email send failed with status ${response.status}`);
      }

      logger.info('Email sent', redactedSubject(message));
    },
  };
}

function createLogMailer(): Mailer {
  return {
    kind: 'log',
    async send(message) {
      // The text part, not the HTML: it is readable in a terminal and it carries
      // the same link. Logging the token is acceptable *here* precisely because
      // this transport cannot run in production.
      logger.warn('Email not sent (no RESEND_API_KEY) — printing it instead', {
        ...redactedSubject(message),
        body: message.text,
      });
    },
  };
}

/**
 * Pick a transport from configuration.
 *
 * The choice is made once at boot rather than per send, so the log line about
 * which transport is in use appears exactly once — where someone will see it.
 */
export function createMailer(config: EnvConfig): Mailer {
  if (config.resendApiKey === '') {
    logger.warn('No RESEND_API_KEY configured; emails will be written to the log');
    return createLogMailer();
  }
  return createResendMailer(config);
}

/**
 * Send without letting a mail failure fail the request.
 *
 * Used by the endpoints whose response must not vary with what happened —
 * forgot-password and resend-verification return the same body whether the
 * address exists at all, so they certainly cannot surface a send error.
 */
export async function sendQuietly(mailer: Mailer, message: EmailMessage): Promise<void> {
  try {
    await mailer.send(message);
  } catch (error) {
    logger.error('Email send failed; continuing', {
      ...redactedSubject(message),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

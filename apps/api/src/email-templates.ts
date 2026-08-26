/**
 * The transactional emails, as pure functions (doc 13 §1).
 *
 * No transport, no config object, no I/O — each takes what it needs and returns
 * a message. That keeps the wording testable, and keeps the decision about
 * *what to say* separate from the decision about *how to send it*.
 *
 * Every message carries both `html` and `text`. The text part is not a courtesy:
 * a mail client with images and HTML disabled shows it instead, and a
 * text-only fallback that omits the link makes the email useless.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Build a link into the web app carrying a token.
 *
 * Uses `URL` rather than string concatenation for two reasons: it encodes the
 * token as a query parameter correctly (base64url is URL-safe, but relying on
 * that is one alphabet change away from broken links), and it normalises a
 * trailing slash on `appUrl`, which is otherwise the classic `//verify-email`.
 */
export function authLink(appUrl: string, path: string, token: string): string {
  const url = new URL(path, appUrl.endsWith('/') ? appUrl : `${appUrl}/`);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Minimal HTML escaping for values interpolated into a message body.
 *
 * A display name is user-controlled and arrives in an email that renders HTML,
 * so `<script>` or a stray `<` has to be neutralised. Ampersand goes first —
 * escaping it after the others would double-escape their output.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How the recipient is addressed: their name if we have one, else neutral. */
function greeting(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? 'Hi there,' : `Hi ${trimmed},`;
}

/**
 * The shared wrapper.
 *
 * Inline styles only, and a table-free single column: email clients strip
 * `<style>` blocks, ignore most selectors, and Outlook renders through Word.
 * Anything cleverer than this degrades unpredictably.
 */
function layout(heading: string, bodyHtml: string): string {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'font-size:15px;line-height:1.6;color:#1a1d23;max-width:520px;margin:0 auto;padding:24px">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #e4e7ec;margin:28px 0 16px">',
    '<p style="font-size:13px;color:#667085;margin:0">',
    'InstantMockAPI — hosted mock APIs from your schema.',
    '</p>',
    '</div>',
  ].join('');
}

/** The one call to action, styled as a button but degrading to a plain link. */
function button(href: string, label: string): string {
  return [
    `<p style="margin:24px 0"><a href="${escapeHtml(href)}" `,
    'style="display:inline-block;background:#5b8cff;color:#ffffff;text-decoration:none;',
    `padding:11px 20px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`,
  ].join('');
}

/**
 * The link is repeated as plain text below the button in every message.
 *
 * Some clients rewrite or refuse to open a styled anchor, and a user who cannot
 * click has to be able to copy. This is the difference between a stuck signup
 * and a completed one.
 */
function fallbackLink(url: string): string {
  return [
    '<p style="font-size:13px;color:#667085;margin:0">',
    'If the button does not work, paste this into your browser:<br>',
    `<span style="color:#5b8cff;word-break:break-all">${escapeHtml(url)}</span>`,
    '</p>',
  ].join('');
}

/** Hours, phrased for a sentence — "24 hours", "1 hour". */
export function describeHours(seconds: number): string {
  const hours = Math.max(1, Math.round(seconds / 3600));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export interface LinkEmailInput {
  readonly to: string;
  readonly name?: string | null;
  readonly url: string;
  readonly expiresInSeconds: number;
}

/** Sent on signup. Until this link is used the account cannot sign in. */
export function verifyEmailMessage(input: LinkEmailInput): EmailMessage {
  const window = describeHours(input.expiresInSeconds);
  return {
    to: input.to,
    subject: 'Confirm your email address',
    html: layout(
      'Confirm your email address',
      [
        `<p style="margin:0 0 8px">${escapeHtml(greeting(input.name))}</p>`,
        '<p style="margin:0">Confirm this address to finish setting up your ',
        'InstantMockAPI account.</p>',
        button(input.url, 'Confirm email address'),
        `<p style="margin:0 0 16px;font-size:13px;color:#667085">This link works once and expires in ${window}.</p>`,
        fallbackLink(input.url),
      ].join(''),
    ),
    text: [
      greeting(input.name),
      '',
      'Confirm this address to finish setting up your InstantMockAPI account:',
      input.url,
      '',
      `This link works once and expires in ${window}.`,
      "If you didn't create an account, you can ignore this email.",
    ].join('\n'),
  };
}

/** Sent on a forgot-password request for an account that has a password. */
export function resetPasswordMessage(input: LinkEmailInput): EmailMessage {
  const window = describeHours(input.expiresInSeconds);
  return {
    to: input.to,
    subject: 'Reset your password',
    html: layout(
      'Reset your password',
      [
        `<p style="margin:0 0 8px">${escapeHtml(greeting(input.name))}</p>`,
        '<p style="margin:0">Someone asked to reset the password for this ',
        'account. If that was you, choose a new one:</p>',
        button(input.url, 'Choose a new password'),
        `<p style="margin:0 0 16px;font-size:13px;color:#667085">This link works once and expires in ${window}. `,
        'Your current password keeps working until you use it.</p>',
        fallbackLink(input.url),
      ].join(''),
    ),
    text: [
      greeting(input.name),
      '',
      'Someone asked to reset the password for this account. If that was you,',
      'choose a new one here:',
      input.url,
      '',
      `This link works once and expires in ${window}.`,
      'If it was not you, ignore this email — your password has not changed.',
    ].join('\n'),
  };
}

/**
 * Sent when someone tries to sign in to an account that has no password.
 *
 * That happens for the accounts created by the old passwordless login, and for
 * Google-only accounts. Rejecting the attempt would strand those users, so the
 * sign-in attempt turns into an invitation to set one.
 */
export function setPasswordMessage(input: LinkEmailInput): EmailMessage {
  const window = describeHours(input.expiresInSeconds);
  return {
    to: input.to,
    subject: 'Set a password for your account',
    html: layout(
      'Set a password for your account',
      [
        `<p style="margin:0 0 8px">${escapeHtml(greeting(input.name))}</p>`,
        '<p style="margin:0">This account does not have a password yet — it was ',
        'created before passwords existed, or through Google. Set one to sign in ',
        'with your email address.</p>',
        button(input.url, 'Set a password'),
        `<p style="margin:0 0 16px;font-size:13px;color:#667085">This link works once and expires in ${window}.</p>`,
        fallbackLink(input.url),
      ].join(''),
    ),
    text: [
      greeting(input.name),
      '',
      'This account does not have a password yet — it was created before',
      'passwords existed, or through Google. Set one here to sign in with your',
      'email address:',
      input.url,
      '',
      `This link works once and expires in ${window}.`,
      'You can keep signing in with Google either way.',
    ].join('\n'),
  };
}

/**
 * Sent to the *existing* address when someone tries to sign up with it.
 *
 * This is what keeps the signup form from being an account-existence oracle
 * (doc 13 §1): the person who submitted the form gets the same neutral response
 * either way, and the only party told that the account exists is whoever already
 * owns it — who has a right to know someone tried.
 */
export function accountExistsMessage(input: {
  to: string;
  name?: string | null;
  signInUrl: string;
  resetUrl: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: 'You already have an InstantMockAPI account',
    html: layout(
      'You already have an account',
      [
        `<p style="margin:0 0 8px">${escapeHtml(greeting(input.name))}</p>`,
        '<p style="margin:0">Someone just tried to sign up with this address, ',
        'and it already has an account. If that was you, sign in instead:</p>',
        button(input.signInUrl, 'Sign in'),
        '<p style="margin:0 0 16px;font-size:13px;color:#667085">',
        `Forgotten your password? <a href="${escapeHtml(input.resetUrl)}" style="color:#5b8cff">Reset it here</a>. `,
        'No account was created and nothing has changed.</p>',
        fallbackLink(input.signInUrl),
      ].join(''),
    ),
    text: [
      greeting(input.name),
      '',
      'Someone just tried to sign up with this address, and it already has an',
      'account. If that was you, sign in instead:',
      input.signInUrl,
      '',
      'Forgotten your password? Reset it here:',
      input.resetUrl,
      '',
      'No account was created and nothing has changed.',
    ].join('\n'),
  };
}

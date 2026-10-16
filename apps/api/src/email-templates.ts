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
 * The app's palette, for inline styles. Mirrors the tokens in
 * `packages/ui/styles.css` (black-first, one green accent) so an email looks
 * like the product it came from.
 */
const COLOR = {
  page: '#000000',
  card: '#0a0a0a',
  border: '#282828',
  text: '#fafafa',
  body: '#d4d4d8',
  muted: '#a1a1a1',
  subtle: '#737373',
  accent: '#3de07f',
  button: '#086830',
  buttonBorder: '#0a7b39',
} as const;

const FONT =
  "'Geist','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Paragraph styles, shared so every message sets text the same way. */
const P = `margin:0;color:${COLOR.body}`;
const NOTE = `margin:0 0 16px;font-size:13px;color:${COLOR.muted}`;

/** The web app's origin, read off a link the message already carries. */
function originOf(link: string): string {
  try {
    return new URL(link).origin;
  } catch {
    return '';
  }
}

/**
 * The shared wrapper: black page, near-black card, logo and wordmark.
 *
 * Inline styles only: email clients strip `<style>` blocks and ignore most
 * selectors. The page colour sits on a wrapping table with `bgcolor` too,
 * because Gmail drops a background set only in CSS on the outer element.
 *
 * The logo is loaded from the web app (`/brand/logo-256.png`) at the origin
 * of the message's own link, so it always matches the deployment that sent it.
 * Clients that block images show the alt text, and the wordmark beside it
 * still names the product.
 */
function layout(heading: string, bodyHtml: string, link: string): string {
  const logo = `${originOf(link)}/brand/logo-256.png`;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.page}" style="background:${COLOR.page};width:100%">`,
    '<tr><td align="center" style="padding:32px 16px">',
    `<div style="max-width:520px;margin:0 auto;text-align:left;font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.body}">`,
    // Lockup: emblem + wordmark, as in the app's sidebar.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr>',
    `<td style="padding:0 12px 0 0"><img src="${escapeHtml(logo)}" width="40" height="40" alt="InstantMockAPI" style="display:block;border-radius:8px;border:1px solid ${COLOR.border}"></td>`,
    `<td style="font-family:${FONT};font-size:18px;font-weight:600;color:${COLOR.text};letter-spacing:-0.01em">`,
    `Instant<span style="color:${COLOR.accent}">Mock</span>API</td>`,
    '</tr></table>',
    // Card.
    `<div style="background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:12px;padding:32px">`,
    `<h1 style="font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:${COLOR.text};margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    '</div>',
    // Footer.
    `<p style="font-size:12px;line-height:1.5;color:${COLOR.subtle};margin:20px 0 0;text-align:center">`,
    'InstantMockAPI — hosted mock APIs from your schema.<br>',
    'You received this because of an action on your account.',
    '</p>',
    '</div>',
    '</td></tr></table>',
  ].join('');
}

/** The one call to action, styled as the app's primary button but degrading to a plain link. */
function button(href: string, label: string): string {
  return [
    `<p style="margin:28px 0"><a href="${escapeHtml(href)}" `,
    `style="display:inline-block;background:${COLOR.button};border:1px solid ${COLOR.buttonBorder};`,
    `color:${COLOR.text};text-decoration:none;padding:12px 22px;border-radius:8px;`,
    `font-weight:600;font-size:15px">${escapeHtml(label)}</a></p>`,
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
    `<p style="font-size:13px;color:${COLOR.muted};margin:0;padding-top:16px;border-top:1px solid ${COLOR.border}">`,
    'If the button does not work, paste this into your browser:<br>',
    `<span style="color:${COLOR.accent};word-break:break-all">${escapeHtml(url)}</span>`,
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
        `<p style="margin:0 0 8px;color:${COLOR.text}">${escapeHtml(greeting(input.name))}</p>`,
        `<p style="${P}">` + 'Confirm this address to finish setting up your ',
        'InstantMockAPI account.</p>',
        button(input.url, 'Confirm email address'),
        `<p style="${NOTE}">This link works once and expires in ${window}.</p>`,
        fallbackLink(input.url),
      ].join(''),
      input.url,
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
        `<p style="margin:0 0 8px;color:${COLOR.text}">${escapeHtml(greeting(input.name))}</p>`,
        `<p style="${P}">` + 'Someone asked to reset the password for this ',
        'account. If that was you, choose a new one:</p>',
        button(input.url, 'Choose a new password'),
        `<p style="${NOTE}">This link works once and expires in ${window}. `,
        'Your current password keeps working until you use it.</p>',
        fallbackLink(input.url),
      ].join(''),
      input.url,
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
        `<p style="margin:0 0 8px;color:${COLOR.text}">${escapeHtml(greeting(input.name))}</p>`,
        `<p style="${P}">` + 'This account does not have a password yet — it was ',
        'created before passwords existed, or through Google. Set one to sign in ',
        'with your email address.</p>',
        button(input.url, 'Set a password'),
        `<p style="${NOTE}">This link works once and expires in ${window}.</p>`,
        fallbackLink(input.url),
      ].join(''),
      input.url,
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
        `<p style="margin:0 0 8px;color:${COLOR.text}">${escapeHtml(greeting(input.name))}</p>`,
        `<p style="${P}">` + 'Someone just tried to sign up with this address, ',
        'and it already has an account. If that was you, sign in instead:</p>',
        button(input.signInUrl, 'Sign in'),
        `<p style="${NOTE}">`,
        `Forgotten your password? <a href="${escapeHtml(input.resetUrl)}" style="color:${COLOR.accent}">Reset it here</a>. `,
        'No account was created and nothing has changed.</p>',
        fallbackLink(input.signInUrl),
      ].join(''),
      input.signInUrl,
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '@instantmockapi/config';
import { createMailer, sendQuietly } from './email.js';
import type { EmailMessage } from './email-templates.js';

const message: EmailMessage = {
  to: 'ada@example.com',
  subject: 'Confirm your email address',
  html: '<p>hello</p>',
  text: 'hello',
};

function configWith(overrides: Partial<EnvConfig>): EnvConfig {
  return {
    resendApiKey: '',
    emailFrom: 'InstantMockAPI <no-reply@example.com>',
    ...overrides,
  } as EnvConfig;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMailer', () => {
  /**
   * The fallback is what lets a developer complete a signup with nothing
   * configured — the link is printed instead of sent.
   */
  it('falls back to the log transport with no API key', () => {
    expect(createMailer(configWith({ resendApiKey: '' })).kind).toBe('log');
  });

  it('uses Resend once a key is configured', () => {
    expect(createMailer(configWith({ resendApiKey: 're_123' })).kind).toBe('resend');
  });

  it('never touches the network on the log transport', async () => {
    await createMailer(configWith({ resendApiKey: '' })).send(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the Resend transport', () => {
  it('posts the message with the configured from-address', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await createMailer(
      configWith({ resendApiKey: 're_123', emailFrom: 'Team <team@example.com>' }),
    ).send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer re_123');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Team <team@example.com>',
      // Resend takes an array even for a single recipient.
      to: ['ada@example.com'],
      subject: 'Confirm your email address',
      html: '<p>hello</p>',
      text: 'hello',
    });
  });

  /**
   * Both parts go on the wire. Sending only `html` would leave a text-only
   * client with an empty message and no way to verify an address.
   */
  it('sends both an html and a text part', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await createMailer(configWith({ resendApiKey: 're_123' })).send(message);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body['html']).toBeTruthy();
    expect(body['text']).toBeTruthy();
  });

  it('carries an abort signal, so a hung mail API cannot hold the request open', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await createMailer(configWith({ resendApiKey: 're_123' })).send(message);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a rejected send, so the caller can decide what to do', async () => {
    fetchMock.mockResolvedValue(new Response('invalid from address', { status: 422 }));
    await expect(
      createMailer(configWith({ resendApiKey: 're_123' })).send(message),
    ).rejects.toThrow(/422/);
  });

  it('propagates a network failure rather than swallowing it', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      createMailer(configWith({ resendApiKey: 're_123' })).send(message),
    ).rejects.toThrow(/ECONNRESET/);
  });
});

describe('sendQuietly', () => {
  /**
   * The neutral endpoints (forgot-password, resend-verification) must return the
   * same response whether or not the address exists — so they cannot surface a
   * send failure either, since a 500 for one address and a 200 for another is
   * itself an existence oracle.
   */
  it('swallows a send failure', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const mailer = createMailer(configWith({ resendApiKey: 're_123' }));
    await expect(sendQuietly(mailer, message)).resolves.toBeUndefined();
  });

  it('still sends on the happy path', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await sendQuietly(createMailer(configWith({ resendApiKey: 're_123' })), message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

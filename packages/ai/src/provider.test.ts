import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@instantmockapi/shared';
import { GeminiProvider, ProviderError } from './provider.js';

const request = { system: 'SYS', turns: [{ role: 'user' as const, text: 'hello' }] };

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function provider(fetchImpl: typeof fetch) {
  return new GeminiProvider({ apiKey: 'secret-key', model: 'gemini-test', fetchImpl });
}

describe('GeminiProvider', () => {
  it('sends the key in a header, never in the URL, and returns the joined text', async () => {
    const fetchImpl = respond(200, {
      candidates: [{ content: { parts: [{ text: '{"a"' }, { text: ':1}' }] } }],
    });
    await expect(provider(fetchImpl).generate(request)).resolves.toBe('{"a":1}');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    expect(String(url)).not.toContain('secret-key');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'secret-key' });

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
  });

  it('applies a timeout signal to the request', async () => {
    const fetchImpl = respond(200, { candidates: [] });
    await provider(fetchImpl).generate(request);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([408, 429, 500, 503])('treats HTTP %i as transient', async (status) => {
    await expect(provider(respond(status, {})).generate(request)).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it.each([400, 401, 403, 404])('treats HTTP %i as a configuration error', async (status) => {
    await expect(provider(respond(status, {})).generate(request)).rejects.toMatchObject({
      kind: 'config',
    });
  });

  it('does not put the provider response body into the error message', async () => {
    const error = await provider(respond(400, { error: { message: 'echo: secret-key' } }))
      .generate(request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(String(error.message)).not.toContain('secret-key');
  });

  describe('rejection logging', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /*
     * Operators need to know WHY Google refused (bad key, API disabled, unknown
     * model) without the message text, which can echo the request.
     */
    it("logs Google's status and reason codes, never its message or the key", async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const body = {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'API key not valid: secret-key',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      };
      await provider(respond(400, body))
        .generate(request)
        .catch(() => undefined);

      expect(warn).toHaveBeenCalledWith('AI provider rejected the request', {
        model: 'gemini-test',
        httpStatus: 400,
        status: 'INVALID_ARGUMENT',
        reasons: ['API_KEY_INVALID'],
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key');
    });

    it('still logs the HTTP status when the error body is not JSON', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const res = new Response('<html>echo: secret-key</html>', { status: 503 });
      await expect(
        provider(vi.fn().mockResolvedValue(res)).generate(request),
      ).rejects.toMatchObject({
        kind: 'transient',
      });
      expect(warn).toHaveBeenCalledWith('AI provider rejected the request', {
        model: 'gemini-test',
        httpStatus: 503,
        status: undefined,
        reasons: [],
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-key');
    });
  });

  it('treats network failures and timeouts as transient', async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(provider(failing).generate(request)).rejects.toMatchObject({ kind: 'transient' });
    const timeout = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(provider(timeout).generate(request)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('treats a prompt block as blocked', async () => {
    await expect(
      provider(respond(200, { promptFeedback: { blockReason: 'SAFETY' } })).generate(request),
    ).rejects.toMatchObject({ kind: 'blocked' });
  });

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])(
    'treats finish reason %s as blocked',
    async (finishReason) => {
      await expect(
        provider(respond(200, { candidates: [{ finishReason }] })).generate(request),
      ).rejects.toMatchObject({ kind: 'blocked' });
    },
  );

  it('treats a 200 with a non-JSON body as a transient ProviderError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>proxy</html>', { status: 200 }));
    const error = await provider(fetchImpl)
      .generate(request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('transient');
  });

  it('treats a timeout while reading a 200 body as transient', async () => {
    const res = new Response('{}', { status: 200 });
    vi.spyOn(res, 'json').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const error = await provider(vi.fn().mockResolvedValue(res))
      .generate(request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('transient');
  });

  it('returns an empty string for an empty candidate, leaving it to the repair loop', async () => {
    await expect(provider(respond(200, { candidates: [] })).generate(request)).resolves.toBe('');
  });
});

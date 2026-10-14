import { describe, expect, it, vi } from 'vitest';
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

  it.each([429, 500, 503])('treats HTTP %i as transient', async (status) => {
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

  it('never reads the body of an error response', async () => {
    const res = new Response('echo: secret-key', { status: 500 });
    const text = vi.spyOn(res, 'text');
    const json = vi.spyOn(res, 'json');
    await provider(vi.fn().mockResolvedValue(res))
      .generate(request)
      .catch(() => undefined);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(res.bodyUsed).toBe(false);
  });

  it('treats network failures and timeouts as transient', async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(provider(failing).generate(request)).rejects.toMatchObject({ kind: 'transient' });
    const timeout = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(provider(timeout).generate(request)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('treats a prompt block or a safety finish as blocked', async () => {
    await expect(
      provider(respond(200, { promptFeedback: { blockReason: 'SAFETY' } })).generate(request),
    ).rejects.toMatchObject({ kind: 'blocked' });
    await expect(
      provider(respond(200, { candidates: [{ finishReason: 'SAFETY' }] })).generate(request),
    ).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('returns an empty string for an empty candidate, leaving it to the repair loop', async () => {
    await expect(provider(respond(200, { candidates: [] })).generate(request)).resolves.toBe('');
  });
});

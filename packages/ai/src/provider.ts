export interface LLMTurn {
  role: 'user' | 'model';
  text: string;
}

export interface LLMRequest {
  system: string;
  turns: LLMTurn[];
}

/** Provider-neutral boundary: swap Gemini without touching the prompt, repair loop or schema. */
export interface LLMProvider {
  readonly model: string;
  /** Raw model text. Throws ProviderError; never returns a parsed object. */
  generate(request: LLMRequest): Promise<string>;
}

/**
 * - `transient` — try again later (network, timeout, 429, 5xx). The worker rethrows so BullMQ retries.
 * - `config` — retrying cannot help (bad key, bad model id, malformed request). Final.
 * - `blocked` — the provider refused the content. Final.
 */
export type ProviderErrorKind = 'transient' | 'config' | 'blocked';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LLMProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: LLMRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${GEMINI_BASE}/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          // Header, not `?key=`: a URL ends up in proxy logs, error traces and
          // monitoring tools; a header does not.
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: request.turns.map((turn) => ({
              role: turn.role,
              parts: [{ text: turn.text }],
            })),
            // Low temperature: the same request should give the same schema.
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (cause) {
      throw new ProviderError('transient', 'The AI provider request did not complete', { cause });
    }

    if (!response.ok) {
      // The body is deliberately not read into the message: it can echo the
      // request, and this message is stored on the proposal.
      const kind =
        response.status === 408 || response.status === 429 || response.status >= 500
          ? 'transient'
          : 'config';
      throw new ProviderError(kind, `The AI provider responded with HTTP ${response.status}`);
    }

    // Callers rely on generate() throwing only ProviderError. A malformed or
    // truncated 200 body (proxy HTML page, timeout mid-read) is an upstream
    // hiccup worth retrying, so it is classified transient.
    let payload: GeminiResponse;
    try {
      payload = (await response.json()) as GeminiResponse;
    } catch (cause) {
      throw new ProviderError('transient', 'The AI provider returned an unreadable response', {
        cause,
      });
    }
    if (payload.promptFeedback?.blockReason) {
      throw new ProviderError('blocked', 'The request was blocked by the AI provider');
    }
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason && BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
      throw new ProviderError('blocked', 'The request was blocked by the AI provider');
    }
    return (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  }
}

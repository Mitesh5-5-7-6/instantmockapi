/**
 * Typed client for the platform API (doc 08). Handles the bearer token,
 * the uniform error envelope, and refresh-token rotation.
 */

import type { ApiErrorEnvelope, AuthTokens } from './api-types';

const TOKEN_STORAGE_KEY = 'instantmockapi.tokens';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; issue: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}

export function loadTokens(): StoredTokens | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: StoredTokens | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (tokens) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ApiErrorEnvelope;
  } catch {
    // non-JSON error body
  }
  return new ApiError(
    response.status,
    envelope?.error.code ?? 'INTERNAL_ERROR',
    envelope?.error.message ?? `Request failed with status ${response.status}`,
    envelope?.error.details,
  );
}

async function tryRefresh(): Promise<boolean> {
  const tokens = loadTokens();
  if (!tokens) {
    return false;
  }
  const response = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!response.ok) {
    saveTokens(null);
    return false;
  }
  const fresh = (await response.json()) as AuthTokens;
  saveTokens({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
  return true;
}

/**
 * Authenticated JSON request against the platform API. On a 401 the client
 * attempts one refresh-token rotation before surfacing the error.
 */
export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; retryOn401?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, retryOn401 = true } = options;
  const tokens = loadTokens();

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && retryOn401 && (await tryRefresh())) {
    return apiFetch<T>(path, { method, body, retryOn401: false });
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Subscribe to a job's SSE progress stream (doc 08 §4). EventSource cannot
 * carry an Authorization header, so this parses the stream via fetch.
 * Returns an abort function.
 */
export function subscribeJobStream(
  jobId: string,
  onSnapshot: (snapshot: unknown) => void,
  onEnd?: () => void,
): () => void {
  const controller = new AbortController();
  const tokens = loadTokens();

  void (async () => {
    try {
      const response = await fetch(`${apiBaseUrl()}/v1/jobs/${jobId}/stream`, {
        headers: tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        onEnd?.();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) {
            try {
              onSnapshot(JSON.parse(dataLine.slice('data: '.length)));
            } catch {
              // skip malformed frame
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted or network failure — the poll-based job query still covers state
    } finally {
      onEnd?.();
    }
  })();

  return () => controller.abort();
}

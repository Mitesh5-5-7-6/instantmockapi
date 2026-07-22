'use client';

/**
 * S6 · Hosted-API playground (doc 11 §S6). Fires real cross-origin requests at
 * the live mock-runtime (apps/mock-runtime) — `baseUrl` already ends at
 * `/p/{projectId}` with no trailing entity. The hosted API is public: no
 * Authorization header, no credentials (CORS reflects any origin).
 */

import { useState } from 'react';
import { Button, Card, CodeBlock, Input, Select, Textarea } from '@instantmockapi/ui';

interface PlaygroundEntity {
  name: string;
  path: string;
}

interface RequestResult {
  status: number;
  statusText: string;
  durationMs: number;
  text: string;
}

const NEEDS_ID: Record<string, boolean> = {
  GET: false,
  POST: false,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

function hasBody(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function pretty(text: string): string {
  if (text.trim() === '') {
    return 'No Content';
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function HostedPlayground({
  baseUrl,
  entities,
  methods,
}: {
  baseUrl: string;
  entities: PlaygroundEntity[];
  methods: string[];
}) {
  const [entityPath, setEntityPath] = useState(entities[0]?.path ?? '');
  const [method, setMethod] = useState(methods[0] ?? 'GET');
  const [recordId, setRecordId] = useState('');
  const [body, setBody] = useState('{\n  "email": "a@b.com"\n}');
  const [page, setPage] = useState('');
  const [limit, setLimit] = useState('');
  const [result, setResult] = useState<RequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const needsId = NEEDS_ID[method] ?? false;
  const showBody = hasBody(method);
  const isListGet = method === 'GET' && recordId.trim() === '';

  const collection = `${baseUrl}/${entityPath}`;
  const recordUrl = recordId.trim()
    ? `${collection}/${encodeURIComponent(recordId.trim())}`
    : collection;
  let url = recordUrl;
  if (isListGet) {
    const search = new URLSearchParams();
    if (page.trim()) search.set('page', page.trim());
    if (limit.trim()) search.set('limit', limit.trim());
    const qs = search.toString();
    url = qs ? `${collection}?${qs}` : collection;
  }

  const bodyInvalid =
    showBody &&
    body.trim() !== '' &&
    !(() => {
      try {
        JSON.parse(body);
        return true;
      } catch {
        return false;
      }
    })();

  const sendDisabled = sending || (needsId && recordId.trim() === '') || bodyInvalid;

  async function send(): Promise<void> {
    setError(null);
    setResult(null);
    if (showBody && body.trim() !== '') {
      try {
        JSON.parse(body);
      } catch {
        setError('Request body is not valid JSON');
        return;
      }
    }
    setSending(true);
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method,
        headers: showBody ? { 'content-type': 'application/json' } : {},
        body: showBody ? body : undefined,
      });
      const text = await response.text();
      setResult({
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.round(performance.now() - started),
        text,
      });
    } catch {
      setError('Request failed — the hosted API may be expired or unreachable.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="ui-stack">
      <h3>Try it</h3>
      <div
        className="ui-row"
        style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-2)' }}
      >
        <Select value={method} onChange={(event) => setMethod(event.target.value)}>
          {methods.map((verb) => (
            <option key={verb} value={verb}>
              {verb}
            </option>
          ))}
        </Select>
        <Select value={entityPath} onChange={(event) => setEntityPath(event.target.value)}>
          {entities.map((entity) => (
            <option key={entity.path} value={entity.path}>
              {entity.name}
            </option>
          ))}
        </Select>
        {method !== 'POST' ? (
          <Input
            value={recordId}
            placeholder={method === 'GET' ? 'record id — blank to list' : 'record id (required)'}
            onChange={(event) => setRecordId(event.target.value)}
            style={{ maxWidth: 220 }}
          />
        ) : null}
        {isListGet ? (
          <>
            <Input
              type="number"
              value={page}
              placeholder="page"
              onChange={(event) => setPage(event.target.value)}
              style={{ maxWidth: 90 }}
            />
            <Input
              type="number"
              value={limit}
              placeholder="limit"
              onChange={(event) => setLimit(event.target.value)}
              style={{ maxWidth: 90 }}
            />
          </>
        ) : null}
        <Button disabled={sendDisabled} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>

      <span className="ui-mono ui-meta">
        {method} {url}
      </span>

      {showBody ? (
        <Textarea
          value={body}
          rows={6}
          onChange={(event) => setBody(event.target.value)}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
      ) : null}
      {bodyInvalid ? <span className="ui-error">Request body is not valid JSON.</span> : null}

      {error ? <p className="ui-error">{error}</p> : null}
      {result ? (
        <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
          <span
            className="ui-mono"
            style={{
              color: result.status >= 400 ? 'var(--status-error)' : 'var(--status-success)',
            }}
          >
            {result.status} {result.statusText} · {result.durationMs}ms
          </span>
          <CodeBlock code={pretty(result.text)} maxHeight={360} />
        </div>
      ) : null}
    </Card>
  );
}

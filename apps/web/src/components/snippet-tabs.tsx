'use client';

/**
 * "Use Your API": one endpoint rendered as a runnable request in three
 * languages.
 *
 * The snippets come from `lib/endpoints`, so what is shown here is generated
 * from the same endpoint description the list is built from — the tab only picks
 * a language.
 */

import { useState } from 'react';
import { CodeBlock } from '@instantmockapi/ui';
import {
  SNIPPET_LANGUAGES,
  buildSnippet,
  endpointUrl,
  exampleBody,
  exampleQuery,
  type EndpointRow,
  type IpsEntity,
  type SnippetLanguage,
} from '../lib/endpoints';
import type { QueryFeatures } from '../lib/api-types';

/** Methods that carry a request body. */
const WRITES = new Set(['POST', 'PUT', 'PATCH']);

export function SnippetTabs({
  baseUrl,
  endpoint,
  entity,
  features,
}: {
  baseUrl: string;
  endpoint: EndpointRow;
  entity?: IpsEntity | undefined;
  features?: QueryFeatures | undefined;
}) {
  const [language, setLanguage] = useState<SnippetLanguage>('curl');

  const url = endpointUrl(baseUrl, endpoint, {
    ...(entity ? { entity } : {}),
    query: exampleQuery(features),
  });
  const body = WRITES.has(endpoint.method) && entity ? exampleBody(entity) : undefined;
  const snippet = buildSnippet({ language, method: endpoint.method, url, body });

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
      <div className="ui-tabs" role="tablist">
        {SNIPPET_LANGUAGES.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={language === entry.id}
            onClick={() => setLanguage(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="ui-meta ui-mono">
        {endpoint.method} {endpoint.path || '/'} — {endpoint.summary}
      </p>
      <CodeBlock code={snippet} />
    </div>
  );
}

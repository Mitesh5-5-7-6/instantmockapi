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
import { CodeBlock, Tabs } from '@instantmockapi/ui';
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
    <div className="flex flex-col gap-3">
      {/* `Tabs`, not a hand-rolled strip: this was one of the copies that had no
          keyboard support, so Left/Right did nothing and each language was its
          own tab stop. */}
      <Tabs
        items={SNIPPET_LANGUAGES}
        active={language}
        onChange={setLanguage}
        label="Snippet language"
      />
      <p className="font-mono text-xs text-muted-foreground">
        {endpoint.method} {endpoint.path || '/'} — {endpoint.summary}
      </p>
      <CodeBlock code={snippet} />
    </div>
  );
}

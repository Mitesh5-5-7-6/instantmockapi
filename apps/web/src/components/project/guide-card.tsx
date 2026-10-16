'use client';

/**
 * The AI-written guide, above the exact AI Context on the Docs tab.
 *
 * Written once per definition and stored, so opening the tab is a plain read.
 * The first visit to a version that has none starts it; the card then polls
 * until it is ready. The markdown is rendered through the same block parser as
 * the Technical Notes, which renders text and never HTML.
 */

import { useMemo, useState } from 'react';
import { Button, Card, FormError, Icon, Note } from '@instantmockapi/ui';
import { useProjectGuide, useRegenerateGuide } from '../../lib/hooks';
import { parseNotesDocument } from '../../lib/notes-document';
import { normalizeError } from '../../lib/errors';
import { notifyFailure } from '../../lib/toast';
import { NotesView } from './notes-view';

export function GuideCard({ projectId, view }: { projectId: string; view: string }) {
  const guide = useProjectGuide(projectId, true, view);
  const regenerate = useRegenerateGuide(projectId, view);
  const [copied, setCopied] = useState(false);
  const markdown = guide.data?.markdown ?? '';
  const blocks = useMemo(() => parseNotesDocument(markdown), [markdown]);

  const rewrite = () =>
    void regenerate.mutateAsync().catch((cause: unknown) => notifyFailure(normalizeError(cause)));

  if (guide.isLoading) {
    return <div className="h-32 animate-pulse rounded-md bg-muted" />;
  }
  if (guide.isError) {
    return (
      <FormError title="Could not load the guide" detail={normalizeError(guide.error).title} />
    );
  }
  const data = guide.data;
  if (!data || data.status === 'unavailable') {
    return data?.reason ? <Note>{data.reason}</Note> : null;
  }

  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
          <Icon name="book" size={18} />
          <h2 style={{ margin: 0 }}>Guide</h2>
          <span className="ui-meta">
            Written by AI{data.version !== undefined ? ` for v${data.version}` : ''}
          </span>
        </div>
        {data.status === 'ready' ? (
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(markdown)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch((cause: unknown) => notifyFailure(normalizeError(cause)))
              }
            >
              <Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy guide'}
            </Button>
            <Button variant="ghost" size="sm" disabled={regenerate.isPending} onClick={rewrite}>
              <Icon name="refresh" size={14} /> Rewrite
            </Button>
          </div>
        ) : null}
      </div>

      {data.status === 'generating' ? (
        <p className="ui-meta" role="status">
          Writing the guide… this takes about 10–20 seconds and happens once per version.
        </p>
      ) : data.status === 'failed' ? (
        <div className="ui-stack">
          <FormError title={data.error?.message ?? 'The guide could not be written.'} />
          <div className="ui-row">
            <Button size="sm" disabled={regenerate.isPending} onClick={rewrite}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <NotesView blocks={blocks} />
      )}
    </Card>
  );
}

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

/** The shape of a guide, shimmering: a heading and a few lines per section. */
function GuideSkeleton({ label }: { label: string }) {
  const line = (width: string, height = 12) => (
    <div className="ui-skeleton" style={{ minHeight: 0, height, width, borderRadius: 4 }} />
  );
  return (
    <div className="ui-stack" role="status" aria-live="polite">
      <span className="ui-meta">{label}</span>
      {[0, 1, 2].map((section) => (
        <div key={section} className="ui-stack" style={{ gap: 'var(--space-2)' }}>
          {line('32%', 18)}
          {line('96%')}
          {line('88%')}
          {line(section === 1 ? '64%' : '74%')}
        </div>
      ))}
    </div>
  );
}

export function GuideCard({ projectId, view }: { projectId: string; view: string }) {
  const guide = useProjectGuide(projectId, true, view);
  const regenerate = useRegenerateGuide(projectId, view);
  const [copied, setCopied] = useState(false);
  const markdown = guide.data?.markdown ?? '';
  const blocks = useMemo(() => parseNotesDocument(markdown), [markdown]);

  const rewrite = () =>
    void regenerate.mutateAsync().catch((cause: unknown) => notifyFailure(normalizeError(cause)));

  if (guide.isLoading) {
    return (
      <Card>
        <GuideSkeleton label="Loading the guide…" />
      </Card>
    );
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
        <GuideSkeleton label="AI is writing the guide… about 10–20 seconds, once per version." />
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

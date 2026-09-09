'use client';

/**
 * The Docs tab (Phase 4 §10, §17, §18).
 *
 * Two documents about one project: the Technical Notes a person reads, and the
 * AI-ready context a person pastes into an assistant. §18 asks that these
 * actions live in one place rather than being scattered, so both are here.
 *
 * ## Rendered, raw and downloaded are one document
 *
 * The API returns markdown. The rendered view is that markdown parsed into
 * blocks, the raw view is that markdown verbatim, and the download is that
 * markdown as bytes. None of the three re-derives anything from the project, so
 * none of them can describe it differently — which is §9's whole argument,
 * applied one layer further out than §9 states it.
 *
 * ## Neither document is stored
 *
 * There is no artifact row, no version to pick and no Regenerate button,
 * because both are built on demand from the canonical definition. That is why
 * this is not part of the Files tab, which serves what a worker produced. The
 * practical consequence for a reader: these are never stale, and they describe
 * the *definition* — which is not necessarily what the hosted API is serving if
 * an edit has not been published. The header says so rather than leaving the
 * user to discover it.
 */

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Button,
  Card,
  CodeBlock,
  ErrorState,
  Icon,
  Note,
  Tabs,
  TabPanel,
} from '@instantmockapi/ui';
import { downloadTextFile, useAiContext, useProject, useTechnicalNotes } from '../../../../lib/hooks';
import {
  documentSections,
  notesFilename,
  parseNotesDocument,
} from '../../../../lib/notes-document';
import { NotesView } from '../../../../components/project/notes-view';
import { normalizeError } from '../../../../lib/errors';
import { notifyFailure } from '../../../../lib/toast';

type DocTab = 'notes' | 'ai';
type NotesMode = 'rendered' | 'markdown';

/**
 * Copy, with a spoken result.
 *
 * The clipboard write can be refused — a browser without permission, or a page
 * that lost focus — and a silent failure on a Copy button is the worst kind:
 * the user pastes stale content and blames whatever they paste it into.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch((cause: unknown) => {
            notifyFailure(normalizeError(cause));
          });
      }}
    >
      <Icon name="copy" size={14} /> {copied ? 'Copied' : label}
    </Button>
  );
}

export default function DocsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [tab, setTab] = useState<DocTab>('notes');
  const [mode, setMode] = useState<NotesMode>('rendered');

  const project = useProject(id);
  const notes = useTechnicalNotes(id);
  // Idle until the tab is opened: a reader who only wants the notes should not
  // pay for a second document.
  const ai = useAiContext(id, tab === 'ai');

  const markdown = notes.data?.markdown ?? '';
  const blocks = useMemo(() => parseNotesDocument(markdown), [markdown]);
  const sections = useMemo(() => documentSections(blocks), [blocks]);

  const filenameFor = (kind: 'notes' | 'ai') =>
    notesFilename(kind, {
      slug: project.data?.slug ?? null,
      name: project.data?.name ?? null,
    });

  if (notes.isError) {
    return (
      <ErrorState
        title="Could not build the technical notes"
        detail={normalizeError(notes.error).title}
        onRetry={() => void notes.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Documentation</h1>
        <p className="text-sm text-muted-foreground">
          Generated from this project&rsquo;s definition, v{notes.data?.version ?? '—'}. Nothing here
          is stored, so it is never out of date with the definition — though the hosted API serves
          the published version, which may be older.
        </p>
      </header>

      <Tabs
        label="Documentation"
        active={tab}
        onChange={setTab}
        items={[
          { id: 'notes', label: 'Technical Notes' },
          { id: 'ai', label: 'AI Context' },
        ]}
      />

      {tab === 'notes' ? (
        <TabPanel id="notes">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs
                label="Notes view"
                active={mode}
                onChange={setMode}
                items={[
                  { id: 'rendered', label: 'Rendered' },
                  { id: 'markdown', label: 'Markdown' },
                ]}
              />
              <div className="flex items-center gap-2">
                <CopyButton text={markdown} label="Copy Markdown" />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={markdown === ''}
                  onClick={() => downloadTextFile(filenameFor('notes'), markdown)}
                >
                  <Icon name="download" size={14} /> Download .md
                </Button>
              </div>
            </div>

            {notes.isLoading ? <div className="h-64 animate-pulse rounded-md bg-muted" /> : null}

            {markdown !== '' && mode === 'rendered' ? (
              <div className="flex flex-col gap-6 lg:flex-row">
                {/*
                 * The outline is a convenience, not the document. It lists `##`
                 * sections only — one entry per entity would make it longer
                 * than what it indexes.
                 */}
                {sections.length > 1 ? (
                  <nav
                    aria-label="Sections"
                    className="flex shrink-0 flex-row flex-wrap gap-x-4 gap-y-1 lg:sticky lg:top-24 lg:w-48 lg:flex-col lg:self-start"
                  >
                    {sections.map((section) => (
                      <a
                        key={section.id}
                        href={`#${section.id}`}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {section.text}
                      </a>
                    ))}
                  </nav>
                ) : null}
                <Card className="min-w-0 flex-1 p-6">
                  <NotesView blocks={blocks} />
                </Card>
              </div>
            ) : null}

            {markdown !== '' && mode === 'markdown' ? (
              <CodeBlock code={markdown} maxHeight={640} />
            ) : null}
          </div>
        </TabPanel>
      ) : (
        <TabPanel id="ai">
          <div className="flex flex-col gap-4">
            <Note>
              Paste this into an assistant before asking it to write client code. It states every
              endpoint&rsquo;s access requirement, every field&rsquo;s type and validation, and the
              authentication configuration — and it contains no keys or tokens.
            </Note>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <CopyButton text={ai.data?.context ?? ''} label="Copy context" />
              <Button
                variant="secondary"
                size="sm"
                disabled={ai.data === undefined}
                onClick={() => downloadTextFile(filenameFor('ai'), ai.data?.context ?? '')}
              >
                <Icon name="download" size={14} /> Download .md
              </Button>
            </div>

            {ai.isLoading ? <div className="h-64 animate-pulse rounded-md bg-muted" /> : null}

            {ai.isError ? (
              <ErrorState
                title="Could not build the AI context"
                detail={normalizeError(ai.error).title}
                onRetry={() => void ai.refetch()}
              />
            ) : null}

            {ai.data !== undefined ? <CodeBlock code={ai.data.context} maxHeight={640} /> : null}
          </div>
        </TabPanel>
      )}
    </div>
  );
}

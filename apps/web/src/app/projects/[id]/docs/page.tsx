'use client';

/**
 * The Docs tab (Phase 4 §10, §17, §18).
 *
 * Three views of one project: the Technical Notes a person reads, the AI-ready
 * context a person pastes into an assistant, and the Blueprint a person shares
 * or re-imports. §18 asks that these actions live in one place rather than
 * being scattered, so all three are here rather than spread across tabs.
 *
 * ## Rendered, raw and downloaded are one document
 *
 * The API returns markdown. The rendered view is that markdown parsed into
 * blocks, the raw view is that markdown verbatim, and the download is that
 * markdown as bytes. None of the three re-derives anything from the project, so
 * none of them can describe it differently — which is §9's whole argument,
 * applied one layer further out than §9 states it.
 *
 * ## Nothing here is stored
 *
 * There is no artifact row, no version to pick and no Regenerate button: all
 * three are built on demand from the canonical definition. That is why
 * this is not part of the Files tab, which serves what a worker produced. The
 * practical consequence for a reader: these are never stale, and they describe
 * the *definition* — which is not necessarily what the hosted API is serving if
 * an edit has not been published. The header says so rather than leaving the
 * user to discover it.
 */

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Button,
  Card,
  CodeBlock,
  ErrorState,
  Icon,
  Note,
  Select,
  Tabs,
  TabPanel,
} from '@instantmockapi/ui';
import {
  downloadTextFile,
  useAiContext,
  useBlueprint,
  useOpenDraft,
  useProject,
  useTechnicalNotes,
  useVersions,
} from '../../../../lib/hooks';
import {
  documentSections,
  notesFilename,
  parseNotesDocument,
} from '../../../../lib/notes-document';
import {
  describeDocsSource,
  documentationViews,
  viewChangesHref,
  type DocsView,
} from '../../../../lib/docs-version';
import { NotesView } from '../../../../components/project/notes-view';
import { normalizeError } from '../../../../lib/errors';
import { notifyFailure } from '../../../../lib/toast';

type DocTab = 'notes' | 'ai' | 'blueprint';
type NotesMode = 'rendered' | 'markdown';

/**
 * A blueprint, as the bytes a user gets.
 *
 * Pretty-printed rather than the compact JSON the API sends, because a
 * blueprint is a file people open, read and diff. The API's own
 * `content-disposition` download is the compact form — same content, and both
 * import identically, since indentation is not data.
 */
const formatBlueprint = (blueprint: Record<string, unknown>): string =>
  `${JSON.stringify(blueprint, null, 2)}\n`;

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
  /*
   * Which definition every document on this tab describes (§20).
   *
   * One selection for the whole tab, not one per document: the Technical Notes
   * and the AI context describe the same project, and letting them drift to
   * different versions is exactly the divergence §9's shared model exists to
   * prevent — one screen showing two answers.
   *
   * The Blueprint pane is the exception and stays on the current definition:
   * an export is a thing you re-import, and a blueprint of a historical version
   * would create a project silently older than the one it came from.
   */
  const [view, setView] = useState<DocsView>('current');

  const openDraft = useOpenDraft(id);
  const hasOpenDraft = openDraft.isSuccess;

  const project = useProject(id);
  const versions = useVersions(id);
  const notes = useTechnicalNotes(id, view);
  // Idle until the tab is opened: a reader who only wants the notes should not
  // pay for a second document.
  const ai = useAiContext(id, tab === 'ai', view);
  const blueprint = useBlueprint(id, tab === 'blueprint');

  const markdown = notes.data?.markdown ?? '';
  const blocks = useMemo(() => parseNotesDocument(markdown), [markdown]);
  const sections = useMemo(() => documentSections(blocks), [blocks]);
  const blueprintJson = useMemo(
    () => (blueprint.data === undefined ? '' : formatBlueprint(blueprint.data)),
    [blueprint.data],
  );

  const viewOptions = useMemo(
    () =>
      project.data === undefined
        ? []
        : documentationViews({
            currentVersion: project.data.currentVersion,
            publishedVersion: project.data.publishedVersion,
            versions: (versions.data?.data ?? []).map((row) => row.version),
            /*
             * A draft is offered only when one exists. `POST /draft` forks on
             * demand, so an always-present option would either 404 or silently
             * create a draft the reader never asked for.
             */
            hasDraft: hasOpenDraft,
          }),
    [project.data, versions.data, hasOpenDraft],
  );

  const changesHref =
    notes.data === undefined ? null : viewChangesHref(id, view, notes.data.version);

  const filenameFor = (kind: 'notes' | 'ai' | 'blueprint') =>
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
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">Documentation</h1>
          <p className="text-sm text-muted-foreground">
            Generated from this project&rsquo;s definition. Nothing here is stored, so it is never
            out of date with the definition it describes.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Describing
            <Select
              value={view}
              onChange={(event) => setView(event.target.value as DocsView)}
              className="w-auto"
            >
              {viewOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>

          {/*
           * §21: a link into Phase 2's compare page, not a second diff engine.
           * Absent for v1 and for a draft, both of which have nothing to
           * compare against — see `viewChangesHref`.
           */}
          {changesHref === null ? null : (
            <Link href={changesHref} className="text-sm text-muted-foreground hover:text-foreground">
              View changes →
            </Link>
          )}
        </div>

        {/*
         * §20's rule, said out loud on the screen as well as in the document.
         *
         * A reader looking at a draft's field list needs to know the hosted API
         * does not serve it — otherwise they write client code against this and
         * get 422s from the live URL.
         */}
        {notes.data === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            This describes {describeDocsSource(notes.data.source, notes.data.version, notes.data.serving)}.
          </p>
        )}

        {viewOptions.find((option) => option.value === view)?.hint === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            {viewOptions.find((option) => option.value === view)?.hint}
          </p>
        )}
      </header>

      <Tabs
        label="Documentation"
        active={tab}
        onChange={setTab}
        items={[
          { id: 'notes', label: 'Technical Notes' },
          { id: 'ai', label: 'AI Context' },
          { id: 'blueprint', label: 'Blueprint' },
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
      ) : tab === 'ai' ? (
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
      ) : (
        <TabPanel id="blueprint">
          <div className="flex flex-col gap-4">
            <Note>
              A blueprint is everything needed to recreate this project — entities, fields,
              relationships, authentication settings and generation options. It carries no keys, no
              tokens and no hosted URL, so it is safe to share. Importing one creates a new project
              with its own credentials.
            </Note>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <CopyButton text={blueprintJson} label="Copy JSON" />
              <Button
                variant="secondary"
                size="sm"
                disabled={blueprint.data === undefined}
                onClick={() => downloadTextFile(filenameFor('blueprint'), blueprintJson)}
              >
                <Icon name="download" size={14} /> Download Blueprint
              </Button>
            </div>

            {blueprint.isLoading ? (
              <div className="h-64 animate-pulse rounded-md bg-muted" />
            ) : null}

            {blueprint.isError ? (
              <ErrorState
                title="Could not build the blueprint"
                detail={normalizeError(blueprint.error).title}
                onRetry={() => void blueprint.refetch()}
              />
            ) : null}

            {blueprintJson !== '' ? <CodeBlock code={blueprintJson} maxHeight={640} /> : null}
          </div>
        </TabPanel>
      )}
    </div>
  );
}

'use client';

/**
 * The Files tab: generated artifacts, their contents, and downloads.
 *
 * This content had no place in the target design at all — the mockup shows an
 * Auth tab instead, which nothing backs. Generated types, validators, docs and
 * Postman collections are the concrete output of the platform, so they got the
 * slot.
 */

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CodeViewer,
  EmptyState,
  FieldError,
  Icon,
  Modal,
  StatusChip,
} from '@instantmockapi/ui';
import {
  downloadArtifact,
  downloadTextFile,
  useArtifactContent,
  useArtifacts,
  useRegenerate,
} from '../../../../lib/hooks';
import { outOfSyncBadge, syncNotices } from '../../../../lib/artifact-sync';
import { normalizeError } from '../../../../lib/errors';
import { useAction } from '../../../../lib/use-action';
import { notifyFailure } from '../../../../lib/toast';

/** Artifacts whose payload is a binary bundle, so there is nothing to render. */
const NON_VIEWABLE = ['export_bundle'];

export default function FilesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const artifacts = useArtifacts(id);
  const regenerate = useAction(useRegenerate(id), { success: 'Regeneration started' });
  const [view, setView] = useState<{ type: string; version: number } | null>(null);
  const content = useArtifactContent(id, view?.type ?? null, view?.version);

  const rows = artifacts.data?.data ?? [];
  const sync = artifacts.data?.meta.sync ?? null;
  // §18: named here because this page is the only place the mismatch between a
  // download and the served schema is visible at all.
  const notices = syncNotices(
    sync,
    rows.map((artifact) => artifact.artifactType),
  );

  return (
    <div className="ui-stack">
      <Card className="ui-stack">
        <div className="ui-row ui-row--between">
          <div>
            <h2>Generated files</h2>
            <p className="ui-meta">
              Every artifact the generators produced for this version. Regenerating one leaves its
              completed siblings untouched.
            </p>
          </div>
          <span className="ui-meta ui-mono">v{artifacts.data?.meta.version ?? '…'}</span>
        </div>

        {notices.map((notice) => (
          <Alert key={notice.title} variant={notice.variant}>
            <AlertTitle>{notice.title}</AlertTitle>
            <AlertDescription>{notice.detail}</AlertDescription>
          </Alert>
        ))}

        {artifacts.isLoading ? <div className="ui-skeleton" /> : null}

        {artifacts.data && rows.length === 0 ? (
          <EmptyState title="Nothing generated yet">
            Generate this project and its files appear here.
          </EmptyState>
        ) : null}

        <div className="ui-grid-cards">
          {rows.map((artifact) => {
            const stale = outOfSyncBadge(artifact.artifactType, sync);
            return (
              <Card key={artifact.id} className="ui-stack">
                <div className="ui-row ui-row--between">
                  <span className="ui-mono">{artifact.artifactType}</span>
                  <StatusChip status={artifact.status} />
                </div>
                <span className="ui-meta ui-mono">
                  v{artifact.version}
                  {artifact.generatedAt
                    ? ` · ${new Date(artifact.generatedAt).toLocaleString()}`
                    : ''}
                </span>
                {stale ? (
                  // Neutral text on a bordered badge, per the theme's
                  // coloured-mark/neutral-label rule — a filled warning chip on
                  // every stale card is exactly the green-and-amber spread the
                  // theme test caps.
                  <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
                    <Badge variant="neutral">
                      <Icon name="alert" size={14} /> {stale.label}
                    </Badge>
                    <span className="ui-meta ui-mono">{stale.detail}</span>
                  </div>
                ) : null}
                {artifact.errorMessage ? <FieldError>{artifact.errorMessage}</FieldError> : null}
                <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      artifact.status !== 'completed' ||
                      NON_VIEWABLE.includes(artifact.artifactType)
                    }
                    onClick={() =>
                      setView({ type: artifact.artifactType, version: artifact.version })
                    }
                  >
                    View
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={artifact.status !== 'completed'}
                    onClick={() => {
                      // A toast, not an inline message: the page keeps its content
                      // either way, and a download is an action whose outcome the
                      // user needs told to them wherever they have scrolled to.
                      downloadArtifact(id, artifact.artifactType, artifact.version).catch(
                        (cause: unknown) => {
                          const failure = normalizeError(cause);
                          notifyFailure({
                            ...failure,
                            title: `Couldn't download ${artifact.artifactType}`,
                            detail: failure.title,
                          });
                        },
                      );
                    }}
                  >
                    <Icon name="download" size={14} /> Download
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={regenerate.isPending}
                    onClick={() =>
                      void regenerate.run([artifact.artifactType]).then((job) => {
                        if (job !== null) {
                          router.push(`/projects/${id}/progress/${job.jobId}`);
                        }
                      })
                    }
                  >
                    <Icon name="refresh" size={14} />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </Card>

      <Modal
        open={view !== null}
        onClose={() => setView(null)}
        title={view ? `${view.type} · v${view.version}` : ''}
      >
        {content.isLoading ? <div className="ui-skeleton" /> : null}
        <CodeViewer
          files={content.data?.files}
          onDownload={(filename, code) => downloadTextFile(filename, code)}
        />
      </Modal>
    </div>
  );
}

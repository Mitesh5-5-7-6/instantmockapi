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
import { Button, Card, CodeViewer, EmptyState, Icon, Modal, StatusChip } from '@instantmockapi/ui';
import {
  downloadArtifact,
  downloadTextFile,
  useArtifactContent,
  useArtifacts,
  useRegenerate,
} from '../../../../lib/hooks';

/** Artifacts whose payload is a binary bundle, so there is nothing to render. */
const NON_VIEWABLE = ['export_bundle'];

export default function FilesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const artifacts = useArtifacts(id);
  const regenerate = useRegenerate(id);
  const [view, setView] = useState<{ type: string; version: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const content = useArtifactContent(id, view?.type ?? null, view?.version);

  const rows = artifacts.data?.data ?? [];

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

        {/* Surfaced inline rather than thrown: a failed download must not take the
            page down, and the message names the artifact that failed. */}
        {downloadError ? (
          <p className="ui-error" role="alert">
            {downloadError}
          </p>
        ) : null}

        {artifacts.isLoading ? <div className="ui-skeleton" /> : null}

        {artifacts.data && rows.length === 0 ? (
          <EmptyState title="Nothing generated yet">
            Generate this project and its files appear here.
          </EmptyState>
        ) : null}

        <div className="ui-grid-cards">
          {rows.map((artifact) => (
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
              {artifact.errorMessage ? (
                <span className="ui-error">{artifact.errorMessage}</span>
              ) : null}
              <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    artifact.status !== 'completed' || NON_VIEWABLE.includes(artifact.artifactType)
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
                    setDownloadError(null);
                    downloadArtifact(id, artifact.artifactType, artifact.version).catch(
                      (cause: Error) =>
                        setDownloadError(`${artifact.artifactType}: ${cause.message}`),
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
                    regenerate.mutate([artifact.artifactType], {
                      onSuccess: (job) => router.push(`/projects/${id}/progress/${job.jobId}`),
                    })
                  }
                >
                  <Icon name="refresh" size={14} />
                </Button>
              </div>
            </Card>
          ))}
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

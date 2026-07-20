'use client';

/**
 * S6 · Project page + S7 · Expired state (doc 11).
 * Hosted API card with countdown, artifact grid with downloads, regenerate,
 * version history with restore. Expired projects keep the shell and offer
 * Generate Again (doc 07 §6).
 */

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CodeBlock,
  CountdownBadge,
  EmptyState,
  Modal,
  SchemaTree,
  StatusChip,
  type SchemaTreeEntity,
} from '@instantmockapi/ui';
import {
  downloadArtifact,
  useArtifacts,
  useGenerate,
  useGenerateAgain,
  useProject,
  useRegenerate,
  useRestoreVersion,
  useVersions,
} from '../../../lib/hooks';

const REGENERATABLE = [
  'json_schema',
  'zod',
  'yup',
  'typescript',
  'mock_data',
  'openapi',
  'postman',
  'hosted_api',
  'export_zip',
];

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const project = useProject(id);
  const artifacts = useArtifacts(id);
  const versions = useVersions(id);
  const generate = useGenerate(id);
  const generateAgain = useGenerateAgain(id);
  const regenerate = useRegenerate(id);
  const restore = useRestoreVersion(id);
  const [regenOpen, setRegenOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(['zod']);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (project.isLoading) {
    return <div className="ui-skeleton" style={{ minHeight: 320 }} />;
  }
  if (project.isError || !project.data) {
    return (
      <EmptyState title="Project not found">
        <Button variant="secondary" onClick={() => router.push('/')}>
          Back to dashboard
        </Button>
      </EmptyState>
    );
  }

  const detail = project.data;
  const isExpired = detail.status === 'expired';

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-row ui-row--between">
        <div>
          <h1>{detail.name}</h1>
          <p className="ui-meta ui-mono">
            v{detail.currentVersion} · {detail.inputType} · methods{' '}
            {detail.generationConfig.methods.join(',')}
          </p>
        </div>
        <div className="ui-row">
          <StatusChip status={detail.status} />
          <Button variant="secondary" size="sm" onClick={() => setSchemaOpen(true)}>
            View schema
          </Button>
        </div>
      </div>

      {isExpired ? (
        /* S7 — hosted assets deleted, shell kept */
        <Card className="ui-stack">
          <h2>Hosting expired</h2>
          <p className="ui-meta">
            The hosted mock API and generated files for this project were cleaned up on schedule.
            Your schema and configuration are intact — regenerate to bring everything back under a
            fresh version.
          </p>
          <div className="ui-row">
            <Button
              disabled={generateAgain.isPending}
              onClick={() =>
                generateAgain.mutate(undefined, {
                  onSuccess: (job) => router.push(`/projects/${id}/progress/${job.jobId}`),
                })
              }
            >
              {generateAgain.isPending ? 'Starting…' : 'Generate again'}
            </Button>
            {generateAgain.isError ? (
              <span className="ui-error">{generateAgain.error.message}</span>
            ) : null}
          </div>
        </Card>
      ) : (
        <Card className="ui-stack">
          <div className="ui-row ui-row--between">
            <h2>Hosted mock API</h2>
            {detail.hosted.expiresAt ? (
              <CountdownBadge expiresAt={detail.hosted.expiresAt} />
            ) : null}
          </div>
          {detail.hosted.url ? (
            <CodeBlock code={detail.hosted.url} />
          ) : (
            <p className="ui-meta">
              Not hosted yet — generate to bring the mock API up
              {detail.generationConfig.methods.length === 0 ? ' (select methods first)' : ''}.
            </p>
          )}
          <div className="ui-row">
            <Button
              disabled={generate.isPending}
              onClick={() =>
                generate.mutate(undefined, {
                  onSuccess: (job) => router.push(`/projects/${id}/progress/${job.jobId}`),
                })
              }
            >
              {generate.isPending
                ? 'Starting…'
                : detail.status === 'draft'
                  ? 'Generate'
                  : 'Regenerate all'}
            </Button>
            <Button variant="secondary" onClick={() => setRegenOpen(true)}>
              Regenerate selected…
            </Button>
            {generate.isError ? <span className="ui-error">{generate.error.message}</span> : null}
          </div>
        </Card>
      )}

      <Card className="ui-stack">
        <div className="ui-row ui-row--between">
          <h2>Artifacts</h2>
          <span className="ui-meta ui-mono">v{artifacts.data?.meta.version ?? '…'}</span>
        </div>
        {downloadError ? <p className="ui-error">{downloadError}</p> : null}
        {artifacts.data && artifacts.data.data.length === 0 ? (
          <p className="ui-meta">Nothing generated yet for this version.</p>
        ) : null}
        <div className="ui-grid-cards">
          {artifacts.data?.data.map((artifact) => (
            <Card key={artifact.id} className="ui-stack">
              <div className="ui-row ui-row--between">
                <span className="ui-mono">{artifact.artifactType}</span>
                <StatusChip
                  status={artifact.status}
                  label={artifact.status === 'generating' ? 'generating' : artifact.status}
                />
              </div>
              {artifact.errorMessage ? (
                <span className="ui-error">{artifact.errorMessage}</span>
              ) : null}
              {artifact.workerId ? (
                <span className="ui-meta ui-mono">worker {artifact.workerId}</span>
              ) : null}
              <div className="ui-row">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={artifact.status !== 'completed'}
                  onClick={() => {
                    setDownloadError(null);
                    downloadArtifact(id, artifact.artifactType).catch((cause: Error) =>
                      setDownloadError(cause.message),
                    );
                  }}
                >
                  Download
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </Card>

      <Card className="ui-stack">
        <h2>Versions</h2>
        {versions.data?.data.length ? (
          <div>
            {versions.data.data.map((version) => (
              <div className="ui-row ui-row--between ui-worker-row" key={version.id}>
                <span className="ui-mono">v{version.version}</span>
                <span className="ui-meta">{new Date(version.createdAt).toLocaleString()}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={restore.isPending || version.version === detail.currentVersion}
                  onClick={() => restore.mutate(version.version)}
                >
                  {version.version === detail.currentVersion ? 'Current' : 'Restore'}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="ui-meta">No snapshots yet — versions appear when you generate.</p>
        )}
      </Card>

      <Modal open={schemaOpen} onClose={() => setSchemaOpen(false)} title="Schema (IPS)">
        <SchemaTree entities={(detail.ips as { entities: SchemaTreeEntity[] }).entities ?? []} />
      </Modal>

      <Modal open={regenOpen} onClose={() => setRegenOpen(false)} title="Regenerate artifacts">
        <div className="ui-stack">
          <p className="ui-meta">
            Only the selected artifacts re-run; completed siblings are untouched.
          </p>
          <div className="ui-grid-cards">
            {REGENERATABLE.map((artifactType) => (
              <label className="ui-checkbox" key={artifactType}>
                <input
                  type="checkbox"
                  checked={selected.includes(artifactType)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(artifactType)
                        ? current.filter((v) => v !== artifactType)
                        : [...current, artifactType],
                    )
                  }
                />
                <span className="ui-mono">{artifactType}</span>
              </label>
            ))}
          </div>
          <div className="ui-row">
            <Button
              disabled={selected.length === 0 || regenerate.isPending}
              onClick={() =>
                regenerate.mutate(selected, {
                  onSuccess: (job) => {
                    setRegenOpen(false);
                    router.push(`/projects/${id}/progress/${job.jobId}`);
                  },
                })
              }
            >
              {regenerate.isPending ? 'Starting…' : `Regenerate ${selected.length}`}
            </Button>
            {regenerate.isError ? (
              <span className="ui-error">{regenerate.error.message}</span>
            ) : null}
          </div>
        </div>
      </Modal>
    </div>
  );
}

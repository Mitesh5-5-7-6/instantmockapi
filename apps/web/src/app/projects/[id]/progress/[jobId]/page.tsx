'use client';

/**
 * S5 · Progress board (doc 11, doc 12 §6) — the signature surface.
 * Live SSE-driven worker rows, honest dependency waits, per-worker retry,
 * and the overall progress bar. Registry-driven: returning to this page
 * shows the true current state.
 */

import { use } from 'react';
import Link from 'next/link';
import { Button, Card, ProgressBar, StatusChip, WorkerRow } from '@instantmockapi/ui';
import { useJob, useJobStream, useProject, useRetryWorker } from '../../../../../lib/hooks';

const D_DEPENDENTS = new Set(['openapi', 'postman', 'hosted_api']);

export default function ProgressPage({
  params,
}: {
  params: Promise<{ id: string; jobId: string }>;
}) {
  const { id, jobId } = use(params);
  useJobStream(jobId);
  const job = useJob(jobId);
  const project = useProject(id);
  const retry = useRetryWorker(jobId);

  const mockDataSettled = job.data?.workers.some(
    (worker) => worker.artifactType === 'mock_data' && worker.status === 'completed',
  );

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-row ui-row--between">
        <div>
          <h1>{project.data?.name ?? 'Generating'}</h1>
          <p className="ui-meta ui-mono">
            job {jobId.slice(-8)} · v{job.data?.version ?? '…'}
          </p>
        </div>
        {job.data ? <StatusChip status={job.data.status} /> : null}
      </div>

      {job.data ? (
        <Card className="ui-stack">
          <div className="ui-row ui-row--between">
            <h2>Workers</h2>
            <span className="ui-meta ui-mono">
              {job.data.progress.settled}/{job.data.progress.total} · {job.data.progress.percent}%
            </span>
          </div>
          <ProgressBar percent={job.data.progress.percent} />
          <div>
            {job.data.workers.map((worker) => (
              <WorkerRow
                key={worker.artifactType}
                worker={worker.worker}
                artifactType={worker.artifactType}
                status={worker.status}
                error={worker.error}
                waitingOn={
                  worker.status === 'queued' &&
                  D_DEPENDENTS.has(worker.artifactType) &&
                  !mockDataSettled
                    ? 'Mock Data'
                    : undefined
                }
                action={
                  worker.status === 'failed' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(worker.worker)}
                    >
                      Retry
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </div>
        </Card>
      ) : (
        <div className="ui-skeleton" />
      )}

      {job.data && (job.data.status === 'completed' || job.data.status === 'failed_partial') ? (
        <div className="ui-row">
          <Link href={`/projects/${id}`}>
            <Button>Open project</Button>
          </Link>
          {job.data.status === 'failed_partial' ? (
            <span className="ui-meta">
              Completed artifacts are ready — retry the failed workers above.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

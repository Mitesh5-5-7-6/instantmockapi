'use client';

/**
 * S5 · Progress board (doc 11, doc 12 §6) — the signature surface.
 * Live SSE-driven worker rows, honest dependency waits, per-worker retry,
 * and the overall progress bar. Registry-driven: returning to this page
 * shows the true current state.
 */

import { useEffect, useRef, use } from 'react';
import Link from 'next/link';
import { Button, Card, ProgressBar, StatusChip, WorkerRow } from '@instantmockapi/ui';
import { useJob, useJobStream, useProject, useRetryWorker } from '../../../../../lib/hooks';
import { notify, notifySuccess } from '../../../../../lib/toast';

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

  /**
   * Announce the outcome once, when the job settles.
   *
   * This is the other half of the generation lifecycle: something told the user
   * "generation started", and without this nothing ever tells them it finished.
   * The toast matters even though this page shows the same state, because the
   * user is free to navigate away while workers run — the notification outlet is
   * mounted outside the page tree precisely so it survives that.
   *
   * Keyed by job id, so a refetch or a reconnecting stream refreshes one
   * notification rather than stacking one per poll.
   */
  const status = job.data?.status ?? null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (status === null || announced.current === status) {
      return;
    }
    if (status === 'completed') {
      announced.current = status;
      notifySuccess(`Version v${job.data?.version ?? ''} generated`.trim(), null, `job-${jobId}`);
      return;
    }
    if (status !== 'failed_partial') {
      return;
    }

    announced.current = status;
    const failed = (job.data?.workers ?? []).filter((worker) => worker.status === 'failed');
    /**
     * The severity turns on `hosted_api`, not on the count.
     *
     * There is no wholly-`failed` job status — a run where everything broke is
     * also `failed_partial` — so the count alone cannot tell "the docs did not
     * build" from "your API did not build". `hosted_api` is the one artifact
     * the runtime needs, which is exactly what `evaluatePromotion` gates on
     * server-side, so the notification agrees with whether the version can
     * actually go live.
     */
    const runtimeFailed = failed.some((worker) => worker.artifactType === 'hosted_api');
    notify({
      variant: runtimeFailed ? 'error' : 'warning',
      title: runtimeFailed ? 'Generation failed' : 'Some artifacts failed',
      detail:
        failed.length > 0
          ? `${failed.map((worker) => worker.artifactType).join(', ')} did not complete.`
          : null,
      key: `job-${jobId}`,
    });
  }, [status, jobId, job.data?.version, job.data?.workers]);

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
          {/* A clean run lands on the Ready screen; a partial one goes straight
              to the project, where the failed artifacts can be retried. */}
          {job.data.status === 'completed' ? (
            <Link href={`/projects/${id}/ready`}>
              <Button>See what was built</Button>
            </Link>
          ) : null}
          <Link href={`/projects/${id}`}>
            <Button variant={job.data.status === 'completed' ? 'secondary' : 'primary'}>
              Open project
            </Button>
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

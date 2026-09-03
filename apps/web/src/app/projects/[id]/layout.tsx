'use client';

/**
 * Shared chrome for every project tab.
 *
 * `useProject` is called here, and every tab calls it too — TanStack Query
 * dedupes on the `['project', id]` key, so the header and the active tab share one
 * request rather than each issuing their own.
 *
 * The layout deliberately does **not** fetch metrics or logs. Those belong to
 * individual tabs, so moving between Overview and Settings does not refetch a
 * 30-day aggregation nobody is looking at.
 */

import { useState, type ReactNode } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { Button, Card, Modal } from '@instantmockapi/ui';
import { ProjectHeader } from '../../../components/project/project-header';
import { apiBaseUrl, currentAccessToken } from '../../../lib/api-client';
import { useDeleteProject, useGenerate, useProject } from '../../../lib/hooks';
import { normalizeError } from '../../../lib/errors';
import { notifyFailure } from '../../../lib/toast';
import { useAction } from '../../../lib/use-action';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const pathname = usePathname();
  const router = useRouter();

  const project = useProject(projectId);
  /**
   * The opening half of the generation lifecycle. The progress board announces
   * the outcome, so between them a user is never left wondering whether the
   * action took.
   */
  const regenerateAll = useAction(useGenerate(projectId), { success: 'Generation started' });
  const remove = useAction(useDeleteProject(), { success: 'Project deleted' });
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (project.isError) {
    return (
      <Card className="ui-stack">
        <h2>Project not found</h2>
        <p className="ui-meta">It may have been deleted, or it belongs to another account.</p>
        <Button variant="secondary" onClick={() => router.replace('/projects')}>
          Back to projects
        </Button>
      </Card>
    );
  }

  if (!project.data) {
    // Skeleton rather than nothing: the header's height is known, so reserving it
    // stops the tab content jumping down once the name arrives.
    return <div className="ui-skeleton" style={{ minHeight: 180 }} />;
  }

  const detail = project.data;

  /**
   * Export downloads through the authorized API.
   *
   * A plain `<a href>` cannot carry the bearer token — the access token lives in
   * memory, not a cookie — so the request is made with fetch and the blob handed
   * to a temporary anchor.
   */
  const onExport = (): void => {
    void (async () => {
      const token = currentAccessToken();
      const response = await fetch(`${apiBaseUrl()}/v1/projects/${projectId}/export`, {
        headers: token !== null ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        // Previously a bare `return`: a failed export was indistinguishable
        // from a click that did nothing.
        notifyFailure({
          ...normalizeError(new Error('export failed')),
          title: "Couldn't export this project",
          detail: `The server answered ${response.status}.`,
        });
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${detail.slug ?? detail.id}-export.json`;
      anchor.click();
      // Revoked immediately: the click has already started the download, and the
      // object URL would otherwise pin the blob in memory for the page's life.
      URL.revokeObjectURL(url);
    })();
  };

  return (
    <div className="ui-stack project-workspace">
      <ProjectHeader
        detail={detail}
        pathname={pathname}
        onExport={onExport}
        // `undefined` explicitly: the mutation takes an optional config, and
        // TanStack still requires the variables argument when its type is not
        // `void`. Navigating to the progress board is what every other generate
        // call site in the app does — a job that starts with no visible progress
        // looks like nothing happened.
        onRegenerate={() => {
          void regenerateAll.run(undefined).then((job) => {
            if (job !== null) {
              router.push(`/projects/${projectId}/progress/${job.jobId}`);
            }
          });
        }}
        onDelete={() => setConfirmDelete(true)}
      />

      {children}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${detail.name}?`}
      >
        <div className="ui-stack">
          <p className="ui-meta">
            The project, its generated files, its mock data and its request history are removed
            permanently. The hosted URL stops resolving immediately.
          </p>
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                void remove.run(projectId).then((deleted) => {
                  if (deleted !== null) {
                    router.replace('/projects');
                  }
                });
              }}
            >
              {remove.isPending ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

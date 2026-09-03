'use client';

/**
 * The project card grid, with its loading, error and empty states.
 *
 * Extracted from the dashboard route so `/projects` can own it. Both routes
 * render it for now — `/` is replaced by the analytics dashboard later in the
 * redesign, and until then extracting without re-rendering it at `/` would take
 * the landing page dark.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CountdownBadge,
  EmptyState,
  ErrorState,
  Modal,
  StatusChip,
} from '@instantmockapi/ui';
import { normalizeError } from '../lib/errors';
import { useAction } from '../lib/use-action';
import { useDeleteProject, useProjects } from '../lib/hooks';
import type { ProjectSummary } from '../lib/api-types';

function projectAction(project: ProjectSummary): { label: string; href: string } {
  switch (project.status) {
    case 'draft':
      return { label: 'Continue setup', href: `/projects/${project.id}` };
    case 'generating':
      return { label: 'View progress', href: `/projects/${project.id}` };
    case 'expired':
      return { label: 'Generate again', href: `/projects/${project.id}` };
    default:
      return { label: 'Open', href: `/projects/${project.id}` };
  }
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const router = useRouter();
  const action = projectAction(project);
  const [confirming, setConfirming] = useState(false);

  /**
   * Deleting is irreversible and takes the hosted URL down immediately, so the
   * confirmation says what actually goes — and it is a `Modal` rather than
   * `window.confirm`, which cannot be styled, cannot be read by the same
   * assistive-tech path as the rest of the app, and blocks the whole tab.
   */
  const remove = useAction(useDeleteProject(), {
    success: `${project.name} deleted`,
  });

  return (
    <Card interactive className="ui-stack">
      <div className="ui-row ui-row--between">
        <h3>{project.name}</h3>
        <StatusChip status={project.status} />
      </div>
      <div className="ui-meta ui-mono">
        v{project.currentVersion} · {project.inputType}
        {project.hosted.expiresAt ? (
          <>
            {' · '}
            <CountdownBadge expiresAt={project.hosted.expiresAt} />
          </>
        ) : null}
      </div>
      <div className="ui-row">
        {/*
          Secondary, not primary. Open / Continue setup / View progress are
          navigation, and this renders once per card — ten filled green buttons
          on one screen is what made the theme unreadable. The single primary on
          this page is "New Project", which actually creates something.
        */}
        <Button size="sm" variant="secondary" onClick={() => router.push(action.href)}>
          {action.label}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={remove.isPending}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${project.name}?`}
      >
        <div className="ui-stack">
          <p className="ui-meta">
            The project, its generated files, its mock data and its request history are removed
            permanently. The hosted URL stops resolving immediately.
          </p>
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                void remove.run(project.id).then(() => setConfirming(false));
              }}
            >
              {remove.isPending ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export function ProjectsView({ title, query }: { title: string; query?: string }) {
  // The API escapes the regex server-side, so the raw term is safe to forward.
  const projects = useProjects({ sort: '-updatedAt', ...(query ? { q: query } : {}) });

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-8)' }}>
      <div className="ui-row ui-row--between">
        <h1>{title}</h1>
        <Link href="/new">
          <Button>New Project</Button>
        </Link>
      </div>

      {projects.isLoading ? (
        <div className="ui-grid-cards">
          <div className="ui-skeleton" />
          <div className="ui-skeleton" />
          <div className="ui-skeleton" />
        </div>
      ) : null}

      {projects.isError ? (
        <ErrorState
          title="Couldn't load projects"
          detail={normalizeError(projects.error).title}
          onRetry={() => void projects.refetch()}
        />
      ) : null}

      {projects.data && projects.data.data.length === 0 && query ? (
        <EmptyState title={`No projects match "${query}"`}>
          <p>Try a different term, or clear the search.</p>
          <Link href="/projects">
            <Button variant="secondary">Show all projects</Button>
          </Link>
        </EmptyState>
      ) : null}

      {projects.data && projects.data.data.length === 0 && !query ? (
        <EmptyState title="No projects yet">
          <p>Paste a JSON sample or build a schema — get a working mock API in minutes.</p>
          <Link href="/new">
            <Button>Create your first project</Button>
          </Link>
        </EmptyState>
      ) : null}

      {projects.data && projects.data.data.length > 0 ? (
        <div className="ui-grid-cards">
          {projects.data.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

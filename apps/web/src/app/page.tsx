'use client';

/**
 * S1 · Dashboard (doc 11): project card grid with status chips, countdowns,
 * per-status actions, empty state, and loading skeletons.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, CountdownBadge, EmptyState, StatusChip } from '@instantmockapi/ui';
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
  const deleteProject = useDeleteProject();
  const action = projectAction(project);

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
        <Button size="sm" onClick={() => router.push(action.href)}>
          {action.label}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={deleteProject.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${project.name}" and everything it generated?`)) {
              deleteProject.mutate(project.id);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const projects = useProjects({ sort: '-updatedAt' });

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-8)' }}>
      <div className="ui-row ui-row--between">
        <h1>Dashboard</h1>
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
        <EmptyState title="Couldn't load projects">
          <p className="ui-error">{projects.error.message}</p>
          <Button variant="secondary" onClick={() => void projects.refetch()}>
            Retry
          </Button>
        </EmptyState>
      ) : null}

      {projects.data && projects.data.data.length === 0 ? (
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

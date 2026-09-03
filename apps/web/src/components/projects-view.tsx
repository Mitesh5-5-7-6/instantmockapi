'use client';

/**
 * The projects table, with its loading, error and empty states.
 *
 * ## Why a table and not the card grid it replaces
 *
 * A card is the right shape when each item needs a different amount of room. A
 * project does not: every row has exactly the same six facts, and the question
 * this screen answers is comparative — *which* of my projects is expiring,
 * which is getting traffic, which never finished generating. A grid makes that
 * comparison impossible, because the eye has to travel a rectangle per project
 * instead of down one column.
 *
 * It also surfaces data the API was already sending and the cards had no room
 * for: `endpointCount` and `requestCount` per row, computed by
 * `GET /v1/projects` and previously discarded at the type boundary.
 *
 * Ten cards became ten small rows, which is the other half of the theme work —
 * a grid of ten bordered rectangles is itself visual noise, whatever colour the
 * buttons are.
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
  Icon,
  Modal,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  tableNumeric,
} from '@instantmockapi/ui';
import { normalizeError } from '../lib/errors';
import { useAction } from '../lib/use-action';
import { useDeleteProject, useProjects } from '../lib/hooks';
import { formatCompact } from '../lib/area-chart';
import { formatAgo } from '../lib/relative-time';
import type { ProjectListRow } from '../lib/api-types';

function projectAction(project: ProjectListRow): { label: string; href: string } {
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

function ProjectRow({ project }: { project: ProjectListRow }) {
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
    <TableRow>
      <TableRowHeader className="max-w-[340px] min-w-[180px]">
        {/*
          The name is the link, so the whole row does not have to be clickable.
          A clickable row with buttons inside it makes Delete a gamble.
        */}
        <Link href={action.href} className="font-medium text-foreground hover:text-accent-text">
          {project.name}
        </Link>
        {project.description ? (
          // Truncates rather than wrapping: a long description would otherwise
          // push one row to two lines and break the scan down the column.
          <span className="mt-0.5 block truncate text-xs text-muted-foreground max-md:hidden">
            {project.description}
          </span>
        ) : null}
      </TableRowHeader>

      <TableCell>
        <StatusChip status={project.status} />
      </TableCell>

      <TableCell className="font-[var(--font-mono)] text-xs whitespace-nowrap max-lg:hidden">
        v{project.currentVersion}
      </TableCell>

      {/* Endpoints and requests are the two figures worth comparing down a
          column, which is the whole argument for a table here. */}
      <TableCell className={`${tableNumeric} font-[var(--font-mono)] max-md:hidden`}>
        {project.endpointCount > 0 ? formatCompact(project.endpointCount) : '—'}
      </TableCell>

      <TableCell className={`${tableNumeric} font-[var(--font-mono)] max-md:hidden`}>
        {project.requestCount > 0 ? formatCompact(project.requestCount) : '—'}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {project.hosted.expiresAt ? (
          <CountdownBadge expiresAt={project.hosted.expiresAt} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="text-xs whitespace-nowrap text-muted-foreground max-lg:hidden">
        {formatAgo(project.updatedAt)}
      </TableCell>

      <TableCell className="w-[1%] text-right whitespace-nowrap">
        <span className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => router.push(action.href)}>
            {action.label}
          </Button>
          {/*
            Icon-only, and ghost rather than danger. In a table this renders once
            per row, so an outlined red button per row would put a column of red
            down the page — the same density mistake the green buttons made. The
            colour belongs on the confirmation, where the decision is.
          */}
          <Button
            size="icon"
            variant="ghost"
            disabled={remove.isPending}
            aria-label={`Delete ${project.name}`}
            onClick={() => setConfirming(true)}
          >
            <Icon name="trash" size={14} />
          </Button>
        </span>

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
      </TableCell>
    </TableRow>
  );
}

export function ProjectsView({ title, query }: { title: string; query?: string }) {
  // The API escapes the regex server-side, so the raw term is safe to forward.
  const projects = useProjects({ sort: '-updatedAt', ...(query ? { q: query } : {}) });

  const rows = projects.data?.data ?? [];
  const windowDays = rows[0]?.requestWindowDays ?? 7;

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-8)' }}>
      <div className="ui-row ui-row--between">
        <h1>{title}</h1>
        <Link href="/new">
          <Button>New Project</Button>
        </Link>
      </div>

      {projects.isLoading ? <div className="ui-skeleton" style={{ minHeight: 240 }} /> : null}

      {projects.isError ? (
        <ErrorState
          title="Couldn't load projects"
          detail={normalizeError(projects.error).title}
          onRetry={() => void projects.refetch()}
        />
      ) : null}

      {projects.data && rows.length === 0 && query ? (
        <EmptyState title={`No projects match "${query}"`}>
          <p>Try a different term, or clear the search.</p>
          <Link href="/projects">
            <Button variant="secondary">Show all projects</Button>
          </Link>
        </EmptyState>
      ) : null}

      {projects.data && rows.length === 0 && !query ? (
        <EmptyState title="No projects yet">
          <p>Paste a JSON sample or build a schema — get a working mock API in minutes.</p>
          <Link href="/new">
            <Button>Create your first project</Button>
          </Link>
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <Card className="ui-stack ui-stack--tight">
          {/* `Table` brings its own scroll container — eight columns do not fit a
              phone, and a horizontally scrolling document is worse than a
              horizontally scrolling table. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                {/*
                  Each header carries the same responsive class as its cells. It
                  has to: hiding a column by class shifts every column after it
                  if the header stays behind.
                */}
                <TableHead className="max-lg:hidden">Version</TableHead>
                <TableHead className={`${tableNumeric} max-md:hidden`}>Endpoints</TableHead>
                {/*
                  The window is in the header rather than a footnote, because
                  `requestCount` is bounded by the ApiLog 30-day TTL and a bare
                  "Requests" column would read as a lifetime total.
                */}
                <TableHead className={`${tableNumeric} max-md:hidden`}>
                  Requests
                  <span className="font-normal"> · {windowDays}d</span>
                </TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="max-lg:hidden">Updated</TableHead>
                {/* Announced, not shown: the column holds only controls. */}
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

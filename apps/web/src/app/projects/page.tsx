'use client';

/**
 * All projects, optionally filtered by `?q=` from the top-bar search.
 *
 * `useSearchParams` opts a route into client-side rendering, so the reader sits
 * behind a Suspense boundary — without one, Next fails the build for this page
 * rather than degrading quietly.
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProjectsView } from '../../components/projects-view';

function ProjectsList() {
  const query = useSearchParams().get('q') ?? '';
  return <ProjectsView title={query ? `Projects matching “${query}”` : 'Projects'} query={query} />;
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="ui-skeleton" style={{ minHeight: 240 }} />}>
      <ProjectsList />
    </Suspense>
  );
}

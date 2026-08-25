'use client';

/**
 * All projects.
 *
 * Gives the "Projects" nav item a real destination, gives the dashboard's
 * "View all" a target, and gives `/projects/[id]` a parent so the sidebar can
 * highlight something while a project is open. Sibling to `projects/[id]` in the
 * App Router — a segment and its dynamic child coexist.
 */

import { ProjectsView } from '../../components/projects-view';

export default function ProjectsPage() {
  return <ProjectsView title="Projects" />;
}

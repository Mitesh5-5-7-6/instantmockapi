'use client';

/**
 * Landing page.
 *
 * Still the project grid, which now lives in `components/projects-view` and is
 * shared with `/projects`. This route becomes the analytics dashboard later in
 * the redesign; rendering the grid here until then keeps the landing page from
 * going dark mid-build.
 */

import { ProjectsView } from '../components/projects-view';

export default function DashboardPage() {
  return <ProjectsView title="Dashboard" />;
}

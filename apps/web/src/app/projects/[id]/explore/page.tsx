'use client';

/**
 * Redirect: `/explore` was this route's name before the workspace gained tabs.
 *
 * Kept rather than deleted because the path may sit in a bookmark or a shared
 * link, and a 404 is a worse answer than a redirect for a page that still exists
 * under a different name.
 *
 * `replace`, not `push`: the old URL should not become a back-button stop that
 * bounces the user forward again.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function ExploreRedirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    router.replace(`/projects/${id}/apis`);
  }, [id, router]);

  return <p className="ui-meta">Redirecting…</p>;
}

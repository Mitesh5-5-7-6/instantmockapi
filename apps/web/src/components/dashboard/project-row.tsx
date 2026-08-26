'use client';

/** One Recent Projects row: coloured initials, name, meta, status, request count. */

import { useRouter } from 'next/navigation';
import { Avatar, ListRow, StatusChip } from '@instantmockapi/ui';
import { avatarFor } from '../../lib/avatar';
import type { RecentProjectRow } from '../../lib/dashboard-metrics';

export function ProjectRow({ row }: { row: RecentProjectRow }) {
  const router = useRouter();
  // Seeded on the id, not the name: renaming a project then keeps its colour in
  // a list someone has learned to scan.
  const { initials, tone } = avatarFor(row.name, row.id);

  return (
    <ListRow
      leading={<Avatar initials={initials} tone={tone} size="md" label={row.name} />}
      title={row.name}
      meta={row.meta}
      trailing={
        <span className="ui-row" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <span className="ui-meta ui-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {row.requests}
          </span>
          <StatusChip status={row.status} label={row.statusLabel} />
        </span>
      }
      onClick={() => router.push(`/projects/${row.id}`)}
    />
  );
}

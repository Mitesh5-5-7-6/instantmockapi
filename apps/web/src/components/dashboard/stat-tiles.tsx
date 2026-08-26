'use client';

/** The four headline tiles. Content comes from `lib/dashboard-metrics`. */

import { Stat } from '@instantmockapi/ui';
import { toStatTiles } from '../../lib/dashboard-metrics';
import type { DashboardView } from '../../lib/api-types';

export function StatTiles({ view }: { view: DashboardView }) {
  return (
    <div className="ui-stats">
      {toStatTiles(view).map((tile) => (
        <Stat
          key={tile.key}
          label={tile.label}
          value={tile.value}
          icon={tile.icon}
          tone={tile.tone}
          {...(tile.delta ? { delta: tile.delta } : {})}
        />
      ))}
    </div>
  );
}

/** Loading placeholder that reserves the tiles' height, so the page does not jump. */
export function StatTilesSkeleton() {
  return (
    <div className="ui-stats">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="ui-skeleton" style={{ height: 108, flex: '1 1 140px' }} />
      ))}
    </div>
  );
}

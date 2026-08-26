'use client';

/** One activity line: tinted icon, sentence, relative timestamp. */

import { IconTile } from '@instantmockapi/ui';
import { activityIcon } from '../../lib/dashboard-metrics';
import { formatAgo } from '../../lib/relative-time';
import type { ActivityEvent } from '../../lib/api-types';

export function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon, tone } = activityIcon(event.type);

  return (
    <div className="ui-list-row">
      <IconTile icon={icon} tone={tone} size="sm" />
      <span className="ui-list-row__body">
        <span className="ui-list-row__title" style={{ whiteSpace: 'normal' }}>
          {event.text}
        </span>
      </span>
      <span className="ui-meta" style={{ whiteSpace: 'nowrap' }}>
        {formatAgo(event.at)}
      </span>
    </div>
  );
}

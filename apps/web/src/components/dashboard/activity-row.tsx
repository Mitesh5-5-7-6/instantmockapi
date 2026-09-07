'use client';

/** One activity line: tinted icon, sentence, relative timestamp. */

import { IconTile, ListRow } from '@instantmockapi/ui';
import { activityIcon } from '../../lib/dashboard-metrics';
import { formatAgo } from '../../lib/relative-time';
import type { ActivityEvent } from '../../lib/api-types';

export function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon, tone } = activityIcon(event.type);

  return (
    <ListRow
      leading={<IconTile icon={icon} tone={tone} size="sm" />}
      title={event.text}
      // The text is a sentence, not a name in a column: clipping it at the row
      // width loses the end of the news.
      wrapTitle
      trailing={
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatAgo(event.at)}
        </span>
      }
    />
  );
}

'use client';

import { Card } from '@instantmockapi/ui';
import type { BuilderEntity } from '../../lib/builder';
import { diffEntities, type EntityChange } from '../../lib/proposal-diff';

export function describeChange(change: EntityChange): string {
  const parts = [
    ...change.fieldChanges.map(
      (f) =>
        `${f.change === 'added' ? '+' : f.change === 'removed' ? '−' : '~'}${f.name}${f.change === 'type' || f.change === 'required' || f.change === 'enum' ? ` (${f.change})` : ''}`,
    ),
    ...change.relationChanges,
  ];
  return parts.join(', ');
}

/** "AI version vs. mine", read-only. */
export function ChangesPanel({
  original,
  current,
}: {
  original: BuilderEntity[];
  current: BuilderEntity[];
}) {
  const changes = diffEntities(original, current).filter((change) => change.kind !== 'same');
  return (
    <Card className="ui-stack">
      <h2>Your changes to the AI suggestion</h2>
      {changes.length === 0 ? (
        <p className="ui-meta">No changes yet.</p>
      ) : (
        <ul>
          {changes.map((change) => (
            <li key={change.key}>
              <strong>{change.name}</strong>:{' '}
              {change.kind === 'added'
                ? 'added by you'
                : change.kind === 'removed'
                  ? 'removed by you'
                  : describeChange(change)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

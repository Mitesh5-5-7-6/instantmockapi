'use client';

import { Button } from '@instantmockapi/ui';

export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

const LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  error: 'Couldn’t save',
  conflict: 'Changed in another tab',
};

export function ActionBar({
  saveStatus,
  canUndo,
  canCreate,
  canRegenerate,
  creating,
  onUndo,
  onShowChanges,
  onRegenerate,
  onCreate,
  onRetrySave,
}: {
  saveStatus: SaveStatus;
  canUndo: boolean;
  canCreate: boolean;
  /** False while the prose is being translated: a regeneration would race it. */
  canRegenerate: boolean;
  creating: boolean;
  onUndo: () => void;
  onShowChanges: () => void;
  onRegenerate: () => void;
  onCreate: () => void;
  onRetrySave: () => void;
}) {
  return (
    <div className="ui-row ui-row--between" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
      <span className="ui-meta" role="status" aria-live="polite">
        {LABEL[saveStatus]}{' '}
        {saveStatus === 'error' ? (
          <Button variant="ghost" size="sm" onClick={onRetrySave}>
            Retry
          </Button>
        ) : null}
      </span>
      <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
        <Button variant="secondary" onClick={onUndo} disabled={!canUndo}>
          Undo
        </Button>
        <Button variant="secondary" onClick={onShowChanges}>
          View changes
        </Button>
        <Button variant="secondary" onClick={onRegenerate} disabled={!canRegenerate}>
          Regenerate…
        </Button>
        <Button onClick={onCreate} disabled={!canCreate || creating}>
          {creating ? 'Creating…' : 'Create API'}
        </Button>
      </div>
    </div>
  );
}

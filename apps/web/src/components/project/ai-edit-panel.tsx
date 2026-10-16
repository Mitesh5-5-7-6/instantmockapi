'use client';

/**
 * "Edit with AI" for an existing project's data model.
 *
 *     prompt ──▶ generating ──▶ per-entity choices ──▶ Apply ──▶ editor form
 *
 * Apply only changes the editor's form. The draft is saved, reviewed and
 * committed exactly as a hand edit is, so the live API is untouched until the
 * user commits and the new version is published.
 *
 * The worker revises the *stored* draft, so the editor saves unsaved edits
 * before a run starts (`onBeforeStart`); otherwise the model would revise a
 * copy the user has already moved past.
 */

import { useMemo, useState } from 'react';
import { Button, Card, FormError, Icon, Note, Select, Textarea } from '@instantmockapi/ui';
import type { BuilderEntity } from '../../lib/builder';
import { aiEditChanges, applyAiEdit, defaultEditChoices } from '../../lib/ai-edit';
import type { MergeChoice } from '../../lib/proposal-diff';
import { stageLabel } from '../../lib/ai-proposal';
import { normalizeError } from '../../lib/errors';
import {
  useAiProposal,
  useCancelAiProposal,
  useRetryAiProposal,
  useStartAiEdit,
} from '../../lib/hooks';
import { describeChange } from '../ai-review/changes-panel';
import { ErDiagram } from '../er-diagram';

const KIND_LABEL = { added: 'New', changed: 'Changed', removed: 'Removed by the AI' } as const;

export function AiEditPanel({
  projectId,
  entities,
  relations,
  noun,
  onBeforeStart,
  onApply,
}: {
  projectId: string;
  /** What the editor holds now; the AI's result is compared against it. */
  entities: BuilderEntity[];
  /** False for a Single API, which cannot have relations. */
  relations: boolean;
  noun: 'entity' | 'endpoint';
  /** Save unsaved edits so the model revises what the user sees. False stops the run. */
  onBeforeStart: () => Promise<boolean>;
  onApply: (next: BuilderEntity[]) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeChoice> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const start = useStartAiEdit(projectId);
  const cancel = useCancelAiProposal();
  const retry = useRetryAiProposal();
  const proposal = useAiProposal(proposalId).data;

  const changes = useMemo(
    () =>
      proposal?.status === 'ready' && proposal.result
        ? aiEditChanges(entities, proposal.result.entities, { relations })
        : [],
    [proposal, entities, relations],
  );
  const visible = changes.filter((change) => change.kind !== 'same');
  const defaults = useMemo(() => defaultEditChoices(changes), [changes]);
  const chosen = choices ?? defaults;
  const preview = useMemo(() => applyAiEdit(changes, chosen), [changes, chosen]);

  const reset = () => {
    setProposalId(null);
    setChoices(null);
    setError(null);
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    setApplied(false);
    if (!(await onBeforeStart())) return;
    try {
      const view = await start.mutateAsync({ prompt: text });
      setChoices(null);
      setProposalId(view.id);
    } catch (cause) {
      setError(normalizeError(cause).title || 'Could not start the AI.');
    }
  };

  const stop = () => {
    // Best effort: a proposal that finished meanwhile cannot be cancelled, and
    // either way the panel goes back to the prompt.
    if (proposalId) void cancel.mutateAsync(proposalId).catch(() => undefined);
    reset();
  };

  const apply = () => {
    onApply(preview);
    if (proposalId) void cancel.mutateAsync(proposalId).catch(() => undefined);
    reset();
    setPrompt('');
    setApplied(true);
  };

  const status = proposal?.status ?? (proposalId ? 'generating' : null);

  return (
    <Card className="ui-stack">
      <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
        <Icon name="zap" size={18} />
        <h2 style={{ margin: 0 }}>Edit with AI</h2>
      </div>

      {status === null || status === 'cancelled' ? (
        <>
          <Textarea
            value={prompt}
            maxLength={1000}
            rows={3}
            placeholder={
              noun === 'endpoint'
                ? 'e.g. Add a weather endpoint with city, temperature and humidity'
                : 'e.g. Add a Review entity linked to Tour, with a 1–5 rating and a comment'
            }
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="ui-row ui-row--between">
            <span className="ui-meta">
              Unsaved edits are saved first. You review every change before it is applied.
            </span>
            <Button disabled={!prompt.trim() || start.isPending} onClick={() => void generate()}>
              {start.isPending ? 'Starting…' : 'Generate changes'}
            </Button>
          </div>
          {applied ? (
            <Note>
              Changes applied below. Check them, then use Review changes to save a new version.
            </Note>
          ) : null}
        </>
      ) : status === 'generating' ? (
        <div className="ui-row ui-row--between">
          <span className="ui-meta">
            {stageLabel(proposal?.stage ?? 'queued')} · “{prompt.trim()}”
          </span>
          <Button variant="secondary" onClick={stop}>
            Cancel
          </Button>
        </div>
      ) : status === 'failed' ? (
        <div className="ui-stack">
          <FormError title={proposal?.error?.message ?? 'The AI could not make this change.'} />
          <div className="ui-row">
            <Button
              disabled={retry.isPending}
              onClick={() =>
                proposalId && void retry.mutateAsync(proposalId).catch(() => undefined)
              }
            >
              Retry
            </Button>
            <Button variant="secondary" onClick={reset}>
              Edit prompt
            </Button>
          </div>
        </div>
      ) : status === 'ready' ? (
        <div className="ui-stack">
          <span className="ui-meta">“{prompt.trim()}”</span>
          {visible.length === 0 ? (
            <Note>
              The AI suggested no changes to your model. Try wording the request differently.
            </Note>
          ) : (
            <ul className="ui-stack" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {visible.map((change) => (
                <li key={change.key} className="ui-row ui-row--between">
                  <span>
                    <strong>{change.name}</strong>{' '}
                    <span className="ui-meta">
                      {KIND_LABEL[change.kind as keyof typeof KIND_LABEL]}
                      {change.kind === 'changed' ? ` — ${describeChange(change)}` : ''}
                    </span>
                  </span>
                  <Select
                    aria-label={`Change to ${change.name}`}
                    value={chosen[change.key] ?? 'mine'}
                    onChange={(event) =>
                      setChoices({ ...chosen, [change.key]: event.target.value as MergeChoice })
                    }
                  >
                    {change.kind === 'added' ? (
                      <>
                        <option value="new">Add it</option>
                        <option value="mine">Skip</option>
                      </>
                    ) : change.kind === 'removed' ? (
                      <>
                        <option value="mine">Keep it</option>
                        <option value="new">Remove it</option>
                      </>
                    ) : (
                      <>
                        <option value="new">Use the AI’s version</option>
                        <option value="mine">Keep mine</option>
                      </>
                    )}
                  </Select>
                </li>
              ))}
            </ul>
          )}
          {visible.length > 0 && relations ? <ErDiagram entities={preview} /> : null}
          <div className="ui-row">
            <Button disabled={visible.length === 0} onClick={apply}>
              Apply to editor
            </Button>
            <Button variant="secondary" onClick={reset}>
              Edit prompt
            </Button>
            <Button variant="ghost" onClick={stop}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <Note>This suggestion is no longer available.</Note>
      )}

      {error ? <FormError title={error} /> : null}
    </Card>
  );
}

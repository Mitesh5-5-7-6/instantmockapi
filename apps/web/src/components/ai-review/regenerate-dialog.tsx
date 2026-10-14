'use client';

import { useMemo, useRef, useState } from 'react';
import { Button, FormError, Modal, Select, Textarea } from '@instantmockapi/ui';
import type { AiProposalView } from '../../lib/api-types';
import { normalizeError } from '../../lib/errors';
import { proposalToBuilder } from '../../lib/builder-payload';
import { diffEntities, mergeEntities, type MergeChoice } from '../../lib/proposal-diff';
import { draftInputFor, type ReviewState } from '../../lib/review-state';
import { stageLabel } from '../../lib/ai-proposal';
import {
  useAdoptAiProposal,
  useAiProposal,
  useCancelAiProposal,
  useRegenerateAiProposal,
  useRetryAiProposal,
} from '../../lib/hooks';
import { describeChange } from './changes-panel';

/** Regenerate → wait → per-entity choice (default "keep mine") → adopt or keep (SP2 D3). */
export function RegenerateDialog({
  open,
  onClose,
  proposal,
  current,
  onAdopted,
}: {
  open: boolean;
  onClose: () => void;
  proposal: AiProposalView;
  current: ReviewState;
  onAdopted: (childId: string) => void;
}) {
  const [answers, setAnswers] = useState(() =>
    (proposal.result?.questions ?? []).map((q) => `${q}\n→ `).join('\n'),
  );
  const [instruction, setInstruction] = useState('');
  const [childId, setChildId] = useState<string | null>(proposal.childId);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [error, setError] = useState<string | null>(null);
  // Set once Apply succeeds: the child is still 'ready' in the cache until the refetch lands.
  const adopted = useRef(false);
  const regenerate = useRegenerateAiProposal(proposal.id);
  const adopt = useAdoptAiProposal();
  const cancel = useCancelAiProposal();
  const retry = useRetryAiProposal();
  const child = useAiProposal(childId).data;

  const changes = useMemo(
    () =>
      child?.status === 'ready' && child.result
        ? diffEntities(current.entities, proposalToBuilder({ ...child, draft: null }).entities)
        : [],
    [child, current.entities],
  );

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(normalizeError(cause).title || 'Something went wrong.');
    }
  }

  function close() {
    // Closing abandons a suggestion that is still being made or waiting for a choice, but never an
    // adopted one. A child whose view has not loaded yet counts as unfinished too. Cancel is best
    // effort: a conflict on an already-finished child is harmless, so the error is dropped.
    if (
      !adopted.current &&
      childId &&
      (!child || child.status === 'generating' || child.status === 'ready')
    ) {
      void cancel.mutateAsync(childId).catch(() => undefined);
    }
    setChildId(null);
    onClose();
  }

  const label = (kind: string) =>
    kind === 'changed'
      ? ['Keep mine', 'Take new']
      : kind === 'added'
        ? ['Skip', 'Add']
        : ['Keep', 'Remove'];

  return (
    <Modal open={open} onClose={close} title="Regenerate suggestion">
      {!childId ? (
        <div className="ui-stack">
          <Textarea
            value={answers}
            rows={6}
            maxLength={1000}
            placeholder="Answers to the questions (optional)"
            onChange={(e) => setAnswers(e.target.value)}
          />
          <Textarea
            value={instruction}
            rows={3}
            maxLength={500}
            placeholder="Anything to change? (optional)"
            onChange={(e) => setInstruction(e.target.value)}
          />
          <Button
            onClick={() =>
              run(async () => {
                const c = await regenerate.mutateAsync({
                  answers: answers.trim() || undefined,
                  instruction: instruction.trim() || undefined,
                });
                adopted.current = false;
                setChildId(c.id);
                setChoices({});
              })
            }
            disabled={regenerate.isPending}
          >
            Regenerate
          </Button>
        </div>
      ) : child?.status === 'generating' ? (
        <p className="ui-meta" role="status">
          {stageLabel(child.stage)}
        </p>
      ) : child?.status === 'failed' ? (
        <div className="ui-stack">
          <FormError title={child.error?.message ?? 'Regeneration failed.'} />
          <div className="ui-row">
            <Button onClick={() => run(() => retry.mutateAsync(child.id))}>Retry</Button>
            <Button variant="secondary" onClick={close}>
              Keep my draft
            </Button>
          </div>
        </div>
      ) : child?.status === 'ready' ? (
        <div className="ui-stack">
          {changes.filter((c) => c.kind !== 'same').length === 0 ? (
            <p className="ui-meta">The new suggestion matches your draft.</p>
          ) : null}
          <ul className="ui-stack">
            {changes
              .filter((c) => c.kind !== 'same')
              .map((change) => {
                const [mineLabel, newLabel] = label(change.kind);
                return (
                  <li key={change.key} className="ui-row ui-row--between">
                    <span>
                      <strong>{change.name}</strong> — {change.kind}
                      {change.kind === 'changed' ? `: ${describeChange(change)}` : ''}
                    </span>
                    <Select
                      value={choices[change.key] ?? 'mine'}
                      onChange={(e) =>
                        setChoices({ ...choices, [change.key]: e.target.value as MergeChoice })
                      }
                    >
                      <option value="mine">{mineLabel}</option>
                      <option value="new">{newLabel}</option>
                    </Select>
                  </li>
                );
              })}
          </ul>
          <div className="ui-row">
            <Button
              disabled={adopt.isPending}
              onClick={() =>
                run(async () => {
                  const merged = { ...current, entities: mergeEntities(changes, choices) };
                  const { input } = draftInputFor(merged, child.result?.entities ?? []);
                  await adopt.mutateAsync({ childId: child.id, draft: input });
                  adopted.current = true;
                  onAdopted(child.id);
                })
              }
            >
              Apply
            </Button>
            <Button variant="secondary" onClick={close}>
              Keep my draft
            </Button>
          </div>
        </div>
      ) : (
        <p className="ui-meta">Loading…</p>
      )}
      {error ? <FormError title={error} /> : null}
    </Modal>
  );
}

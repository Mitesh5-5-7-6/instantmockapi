'use client';

/**
 * The data-model editor.
 *
 * ## It edits the draft. Only the draft.
 *
 * There is no operation on this screen that touches the live definition. Every
 * save is a `PATCH /draft`; the definition moves exactly once, at commit, and
 * even then the hosted API keeps serving its own version until a generation
 * finishes and the runtime is promoted. "Update currentVersion" is not an
 * editing operation and does not exist here.
 *
 *     GET  /draft ──▶ form ──▶ PATCH /draft ──▶ GET /draft/impact ──▶ POST /commit
 *
 * ## Two stages, not a wizard
 *
 * Editing and reviewing are separate views of the same draft rather than steps
 * with state of their own. The draft lives on the server, so a reload, a closed
 * tab or a crashed browser loses nothing — which is the reason it is a document
 * and not component state.
 *
 * ## Nothing is computed here
 *
 * The diff, the affected-API list and the artifact set all come from
 * `/draft/impact`. See `review-changes.tsx` for why that matters.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, EmptyState, Icon, Note } from '@instantmockapi/ui';
import { EntityCard } from '../../../../components/builder/entity-card';
import { ReviewChanges } from '../../../../components/project/review-changes';
import { newEntity, type BuilderEntity } from '../../../../lib/builder';
import { validateRelations } from '../../../../lib/relations';
import {
  applyBuilderToIps,
  ipsToBuilder,
  isDirty,
  type IpsLike,
} from '../../../../lib/draft-schema';
import {
  useCommitDraft,
  useDiscardDraft,
  useDraft,
  useDraftImpact,
  useOpenDraft,
  useProject,
  useReforkDraft,
  useSaveDraft,
} from '../../../../lib/hooks';
import { ApiError } from '../../../../lib/api-client';

type Stage = 'edit' | 'review';

const message = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

export default function EditProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const project = useProject(id);
  const draft = useDraft(id);
  const openDraft = useOpenDraft(id);
  const saveDraft = useSaveDraft(id);
  const discardDraft = useDiscardDraft(id);
  const reforkDraft = useReforkDraft(id);
  const commitDraft = useCommitDraft(id);

  const [stage, setStage] = useState<Stage>('edit');
  const [entities, setEntities] = useState<BuilderEntity[] | null>(null);
  /**
   * The draft the form was loaded from.
   *
   * Held separately because saving is a *merge* onto it — see `draft-schema.ts`.
   * Without the original, the derived fields and metadata the form never shows
   * would be dropped on the first save.
   */
  const [base, setBase] = useState<IpsLike | null>(null);

  // Impact is only fetched on the review stage. Recomputing it on every
  // keystroke would be a request per character for an answer nobody is reading.
  const impact = useDraftImpact(id, stage === 'review');

  /**
   * Fork a draft when the page is opened without one.
   *
   * A 404 from `/draft` is the ordinary "nothing open" answer, not a failure, so
   * it is the trigger rather than an error to report. Guarded on `isPending` so a
   * slow POST is not fired twice.
   */
  const draftMissing = draft.isError && (draft.error as ApiError | undefined)?.status === 404;
  const forkPending = openDraft.isPending || openDraft.isSuccess;
  useEffect(() => {
    if (draftMissing && !forkPending) {
      openDraft.mutate();
    }
    // `openDraft` is intentionally absent from the deps: react-query rebuilds
    // the mutation object on every render, so depending on it would re-run this
    // effect continuously. The two booleans are the whole of what the condition
    // reads, so they are the whole of what should retrigger it.
  }, [draftMissing, forkPending]);

  /**
   * Load the server's draft into the form whenever the stored draft changes.
   *
   * Keyed on `updatedAt`, which means a save DOES reload the form. That is
   * deliberate and not merely tolerable: `PATCH /draft` materializes relations
   * and mints ids for newly added fields, so the server's copy is strictly richer
   * than what was sent. Keeping the local form instead would leave new fields
   * id-less, and the *next* save would mint a second set of ids — making the diff
   * report a field the user just added as removed and re-added, which is the
   * exact failure the stable ids exist to prevent.
   *
   * The trade: anything typed during the save round trip is replaced by the
   * server's answer. That window is one request long, and losing a keystroke is
   * a great deal better than corrupting the change history.
   */
  const loadedAt = draft.data?.updatedAt ?? null;
  useEffect(() => {
    if (draft.data === undefined) {
      return;
    }
    const ips = draft.data.ips as IpsLike;
    setBase(ips);
    setEntities(ipsToBuilder(ips));
    // Keyed on the timestamp alone; see the docstring above for why reloading on
    // every save is the correct behaviour rather than a bug.
  }, [loadedAt]);

  const targets = useMemo(
    () => (entities ?? []).map((entity) => entity.name).filter((name) => name !== ''),
    [entities],
  );
  const issues = useMemo(() => validateRelations(entities ?? []), [entities]);
  const dirty = base !== null && entities !== null && isDirty(base, entities);

  const updateEntity = (entityId: string, next: BuilderEntity): void => {
    setEntities((current) =>
      (current ?? []).map((entity) => (entity.id === entityId ? next : entity)),
    );
  };

  const save = async (): Promise<void> => {
    if (base === null || entities === null) {
      return;
    }
    await saveDraft.mutateAsync({ ips: applyBuilderToIps(base, entities) });
  };

  /**
   * Save first, then review.
   *
   * The impact is computed server-side from the *stored* draft, so reviewing
   * unsaved edits would show the user an analysis of something else entirely.
   */
  const review = async (): Promise<void> => {
    try {
      if (dirty) {
        await save();
      }
      setStage('review');
    } catch {
      // The mutation's own error state renders below; nothing to add here.
    }
  };

  const commit = async (input: { artifacts: string[]; acknowledgeImpact: string }) => {
    const result = await commitDraft.mutateAsync(input);
    if (result.committed && result.job !== null) {
      router.push(`/projects/${id}/progress/${result.job.jobId}`);
    } else {
      router.push(`/projects/${id}`);
    }
  };

  const discard = async (): Promise<void> => {
    await discardDraft.mutateAsync();
    router.push(`/projects/${id}/schema`);
  };

  if (project.isLoading || (draft.isLoading && !draft.isError)) {
    return <div className="ui-skeleton" />;
  }

  if (draft.isError && (draft.error as ApiError | undefined)?.status !== 404) {
    return (
      <Card className="ui-stack">
        <h2>Could not open the editor</h2>
        <p className="ui-error">{message(draft.error)}</p>
      </Card>
    );
  }

  if (entities === null) {
    return <div className="ui-skeleton" />;
  }

  if (stage === 'review') {
    if (impact.isLoading) {
      return <div className="ui-skeleton" />;
    }
    if (impact.data === undefined) {
      return (
        <Card className="ui-stack">
          <h2>Could not analyse the changes</h2>
          <p className="ui-error">{message(impact.error)}</p>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setStage('edit')}>
              Back to editing
            </Button>
          </div>
        </Card>
      );
    }
    return (
      <ReviewChanges
        analysis={impact.data}
        busy={commitDraft.isPending}
        error={commitDraft.isError ? message(commitDraft.error) : null}
        onCancel={() => setStage('edit')}
        onConfirm={(input) => void commit(input)}
      />
    );
  }

  return (
    <div className="ui-stack">
      <Card className="ui-stack ui-stack--tight">
        <div className="ui-row ui-row--between">
          <div>
            <h2>Edit data model</h2>
            <span className="ui-meta">
              Draft from v{draft.data?.baseVersion ?? '—'} · your live API is untouched until you
              commit and regenerate
            </span>
          </div>
          <Link className="ui-btn" href={`/projects/${id}/schema`}>
            Back to schema
          </Link>
        </div>
      </Card>

      {/*
        Staleness is reported, not enforced, here. The draft stays editable — a
        user's work must never be trapped behind an error — and the commit
        endpoint is what refuses. Re-forking discards the edits, so it is offered
        rather than performed.
      */}
      {draft.data?.stale === true && (
        <Note variant="warning">
          The project moved to v{draft.data.currentVersion} while this draft was open (it was
          started from v{draft.data.baseVersion}). You can keep editing, but committing will be
          refused until the draft is re-forked — which discards these edits.{' '}
          <button
            type="button"
            className="ui-btn ui-btn--sm"
            disabled={reforkDraft.isPending}
            onClick={() => void reforkDraft.mutateAsync()}
          >
            {reforkDraft.isPending ? 'Re-forking…' : 'Re-fork from v' + draft.data.currentVersion}
          </button>
        </Note>
      )}

      {/*
        The identity field and foreign keys are absent from these cards on
        purpose — `materializeRelations` owns them server-side, and offering to
        rename a key that the next save recreates would be a trap.
      */}
      <Note>
        The identity field and relation foreign keys are managed for you and are not shown here. Add
        or change a relation and they follow.
      </Note>

      {entities.length === 0 ? (
        <EmptyState title="No entities">
          <p className="ui-meta">This project has nothing to edit yet.</p>
          <Button onClick={() => setEntities([newEntity('')])}>Add the first entity</Button>
        </EmptyState>
      ) : (
        entities.map((entity) => (
          <EntityCard
            key={entity.id}
            entity={entity}
            targets={targets}
            issues={issues.filter((issue) => issue.entityId === entity.id)}
            removable={entities.length > 1}
            onChange={(next) => updateEntity(entity.id, next)}
            onRemove={() =>
              setEntities((current) => (current ?? []).filter((item) => item.id !== entity.id))
            }
          />
        ))
      )}

      <div className="ui-row">
        <Button
          variant="secondary"
          onClick={() => setEntities((current) => [...(current ?? []), newEntity('')])}
        >
          <Icon name="plus" size={16} /> Add entity
        </Button>
      </div>

      {saveDraft.isError && <p className="ui-error">{message(saveDraft.error)}</p>}
      {discardDraft.isError && <p className="ui-error">{message(discardDraft.error)}</p>}

      <Card className="ui-row ui-row--between">
        <span className="ui-meta">
          {dirty ? 'Unsaved changes' : 'Saved'}
          {issues.length > 0 ? ` · ${issues.length} relation issue(s)` : ''}
        </span>
        <span className="ui-row">
          <button
            type="button"
            className="ui-btn"
            disabled={discardDraft.isPending}
            onClick={() => void discard()}
          >
            Discard draft
          </button>
          <button
            type="button"
            className="ui-btn"
            disabled={!dirty || saveDraft.isPending}
            onClick={() => void save()}
          >
            {saveDraft.isPending ? 'Saving…' : 'Save draft'}
          </button>
          <Button disabled={saveDraft.isPending || issues.length > 0} onClick={() => void review()}>
            Review changes <Icon name="chevron-right" size={16} />
          </Button>
        </span>
      </Card>
    </div>
  );
}

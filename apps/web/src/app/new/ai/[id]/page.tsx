'use client';

import { use, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, FlowScope, FormError, Note } from '@instantmockapi/ui';
import {
  useAiProposal,
  useCommitAiProposal,
  useSaveAiDraft,
  useTranslateAiProposal,
} from '../../../../lib/hooks';
import { apiFetch, ApiError } from '../../../../lib/api-client';
import type { AiProposalView } from '../../../../lib/api-types';
import { normalizeError, type FailureDetail } from '../../../../lib/errors';
import { resolveDetails, type FieldPathIndex } from '../../../../lib/error-paths';
import { notifyFailure } from '../../../../lib/toast';
import { proposalToBuilder } from '../../../../lib/builder-payload';
import { clientIssueCount, draftInputFor, type ReviewAction } from '../../../../lib/review-state';
import {
  canCreateApi,
  initialSession,
  nextTranslation,
  sessionReducer,
  type SeenProse,
} from '../../../../lib/review-session';
import { validateRelations } from '../../../../lib/relations';
import { DraftSaver, type SaverSnapshot } from '../../../../lib/draft-saver';
import { REVIEW_PROPOSAL_QUERY } from '../../../../lib/ai-proposal';
import { OverviewCard } from '../../../../components/ai-review/overview-card';
import { ModelSection } from '../../../../components/ai-review/model-section';
import { EndpointsSection } from '../../../../components/ai-review/endpoints-section';
import { AuthSection } from '../../../../components/ai-review/auth-section';
import { ChangesPanel } from '../../../../components/ai-review/changes-panel';
import { ActionBar } from '../../../../components/ai-review/action-bar';
import { RegenerateDialog } from '../../../../components/ai-review/regenerate-dialog';

const AUTOSAVE_MS = 800;

type DraftBody = ReturnType<typeof draftInputFor>;
type SavedDraft = Awaited<ReturnType<ReturnType<typeof useSaveAiDraft>['mutateAsync']>>;

/** Server issues, with the path index of the payload they were reported against. */
interface Issues {
  list: FailureDetail[];
  pathIndex: FieldPathIndex;
}

const NO_ISSUES: Issues = { list: [], pathIndex: new Map() };

export default function AiReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Keyed by id: after Apply the router moves from the parent to the adopted child,
  // and Next may reuse this component. A new key gives the child a fresh form,
  // undo history and autosave instead of the parent's.
  return <AiReview key={id} id={id} />;
}

function AiReview({ id }: { id: string }) {
  const router = useRouter();
  const query = useAiProposal(id, REVIEW_PROPOSAL_QUERY);
  const proposal = query.data;
  const save = useSaveAiDraft(id);
  const translate = useTranslateAiProposal(id);
  const commit = useCommitAiProposal();

  const [session, dispatchSession] = useReducer(sessionReducer, undefined, initialSession);
  const [loaded, setLoaded] = useState(false);
  const [issues, setIssues] = useState<Issues>(NO_ISSUES);
  const [saveState, setSaveState] = useState<SaverSnapshot>({
    status: 'saved',
    dirty: false,
    pending: false,
  });
  const [showChanges, setShowChanges] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The AI prose the form was last reconciled with, to spot a finished translation. */
  const seen = useRef<SeenProse | null>(null);
  /** The last `editSeq` handed to autosave. */
  const handledSeq = useRef(0);

  // The saver outlives renders, so it reaches the mutation and query through a ref
  // that always holds this render's values.
  const live = useRef({ save, query });
  useEffect(() => {
    live.current = { save, query };
  });
  const [saver] = useState(
    () =>
      new DraftSaver<DraftBody, SavedDraft>({
        delayMs: AUTOSAVE_MS,
        write: (body, revision) => live.current.save.mutateAsync({ ...body.input, revision }),
        revisionOf: (saved) => saved.draft.revision,
        isConflict: (cause) => cause instanceof ApiError && cause.status === 409,
        onSaved: (saved, body) => setIssues({ list: saved.issues, pathIndex: body.pathIndex }),
        // Another tab saved, or the proposal stopped being editable. The refetch tells
        // which: a non-ready status routes away below; a ready one shows the banner.
        onConflict: () => void live.current.query.refetch(),
        onChange: setSaveState,
      }),
  );
  // Leaving the page (or this proposal) sends the last edits instead of dropping them.
  useEffect(() => () => void saver.flush().catch(() => undefined), [saver]);

  const initFrom = useCallback(
    (view: AiProposalView) => {
      dispatchSession({ type: 'init', state: proposalToBuilder(view) });
      saver.reset(view.draft?.revision ?? 0);
      seen.current = {
        language: view.responseLanguage,
        description: view.result?.description ?? '',
      };
      setIssues(NO_ISSUES);
      setLoaded(true);
    },
    [saver],
  );

  // First load, once. Waits for a fetch made by this page: a cached view (e.g. the
  // child the dialog just adopted) may be older than the saved draft, and starting
  // from it would make the first autosave conflict with ourselves.
  useEffect(() => {
    if (loaded || !query.isFetchedAfterMount) return;
    if (proposal?.status !== 'ready' || !proposal.result) return;
    initFrom(proposal);
  }, [loaded, query.isFetchedAfterMount, proposal, initFrom]);

  // Route away from proposals this page cannot edit. Not while Create runs: it
  // commits the proposal itself and is already on its way to the progress page.
  const status = proposal?.status;
  const childId = proposal?.childId ?? null;
  const projectId = proposal?.projectId ?? null;
  useEffect(() => {
    if (creating) return;
    if (status === 'superseded' && childId) router.replace(`/new/ai/${childId}`);
    else if (status === 'committed' && projectId) router.replace(`/projects/${projectId}`);
  }, [status, childId, projectId, creating, router]);

  // A finished translation replaces the description if the user hasn't edited it.
  // Depends on the prose only, never on the form, so applying it cannot re-trigger it.
  const language = proposal?.responseLanguage ?? null;
  const aiDescription = proposal?.result?.description;
  useEffect(() => {
    if (!loaded || seen.current === null || aiDescription === undefined) return;
    const now = { language, description: aiDescription };
    const change = nextTranslation(seen.current, now);
    seen.current = now;
    if (change) dispatchSession({ type: 'translate', ...change });
  }, [loaded, language, aiDescription]);

  const state = session.current;
  const entities = proposal?.result?.entities;
  const draft = useMemo(
    () => (state && entities ? draftInputFor(state, entities) : null),
    [state, entities],
  );

  // Every saved change (edit, undo, translation) goes to autosave once. Held while
  // Create runs: the proposal is 'committing', so a save would 409 and turn a failed
  // commit into a false "changed in another tab". A change made meanwhile (a
  // translation landing) is saved once Create gives up, since its seq is still unhandled.
  useEffect(() => {
    if (!draft || creating || session.editSeq === handledSeq.current) return;
    handledSeq.current = session.editSeq;
    saver.edit(draft);
  }, [session.editSeq, draft, saver, creating]);

  // The form is read-only while Create runs (see the fieldset below); this also drops
  // anything dispatched in the moment before it re-renders disabled.
  const dispatch = useCallback(
    (action: ReviewAction) => {
      if (!creating) dispatchSession({ type: 'edit', action });
    },
    [creating],
  );

  const resolved = useMemo(() => resolveDetails(issues.list, issues.pathIndex), [issues]);
  const clientIssues = useMemo(() => (state ? clientIssueCount(state.entities) : 0), [state]);

  // "AI version vs. mine": the result as the AI produced it, ignoring the draft.
  const aiEntities = useMemo(
    () =>
      showChanges && proposal?.result
        ? proposalToBuilder({ ...proposal, draft: null }).entities
        : null,
    [showChanges, proposal],
  );

  async function loadLatest() {
    setError(null);
    const fresh = await query.refetch();
    if (fresh.isError || !fresh.data) {
      setError(normalizeError(fresh.error).title || 'Could not load the latest version.');
      return;
    }
    // A proposal that is no longer ready is handled by the redirect and the view below.
    if (fresh.data.status === 'ready' && fresh.data.result) initFrom(fresh.data);
  }

  async function create() {
    if (!draft) return;
    setError(null);
    setCreating(true);
    try {
      // Normally a no-op (Create needs a saved form), but never commit an older draft.
      await saver.flush();
    } catch (cause) {
      setError(normalizeError(cause).title || 'Your changes could not be saved.');
      setCreating(false);
      return;
    }
    let newProjectId: string;
    try {
      newProjectId = (await commit.mutateAsync({ proposalId: id })).id;
    } catch (cause) {
      setCreating(false);
      if (cause instanceof ApiError && cause.status === 409) {
        // Already committed (or no longer ready): the refetch routes to where it went.
        void query.refetch();
      } else if (cause instanceof ApiError && cause.details?.length) {
        // The commit re-validates; show its answer on the fields like a save's.
        setIssues({ list: cause.details, pathIndex: draft.pathIndex });
      }
      setError(normalizeError(cause).title || 'Could not create the API.');
      return;
    }
    try {
      const job = await apiFetch<{ jobId: string }>(`/v1/projects/${newProjectId}/generate`, {
        method: 'POST',
        body: {},
      });
      router.push(`/projects/${newProjectId}/progress/${job.jobId}`);
    } catch (cause) {
      // The project exists; generation can be started from its page.
      notifyFailure({
        ...normalizeError(cause),
        title: 'Project created, but generation did not start',
      });
      router.push(`/projects/${newProjectId}`);
    }
  }

  function back(message: string, href = '/new/ai') {
    return (
      <div className="ui-stack" style={{ maxWidth: '760px' }}>
        <Note variant="info">{message}</Note>
        <div>
          <Button variant="secondary" onClick={() => router.push(href)}>
            Back to the AI builder
          </Button>
        </div>
      </div>
    );
  }

  if (!proposal) {
    return query.isError ? (
      back(normalizeError(query.error).title || 'This proposal could not be loaded.')
    ) : (
      <div className="ui-skeleton" />
    );
  }
  // While Create runs the form stays up: the commit makes the proposal non-ready on purpose.
  if (!creating && proposal.status !== 'ready') {
    const redirecting =
      (proposal.status === 'superseded' && childId) ||
      (proposal.status === 'committed' && projectId);
    if (redirecting) return <div className="ui-skeleton" />;
    return proposal.status === 'cancelled'
      ? // Spec §7: back to the builder with the prompt kept, ready to edit and generate again.
        back(
          'This proposal was cancelled.',
          `/new/ai?prompt=${encodeURIComponent(proposal.prompt)}`,
        )
      : back(`This proposal is not ready to review (${proposal.status}).`);
  }
  if (!loaded || !state || !proposal.result) return <div className="ui-skeleton" />;

  const result = proposal.result;
  const canCreate = canCreateApi({
    authAnswered: state.authMode !== null,
    issueCount: issues.list.length,
    clientIssueCount: clientIssues,
    save: saveState,
  });

  return (
    <FlowScope flow={state.kind === 'single' ? 'single' : 'project'}>
      <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: '960px' }}>
        <h1>Review your API</h1>
        {saveState.status === 'conflict' ? (
          <Note variant="warning">
            This proposal was changed in another tab. Loading the latest version discards the
            unsaved changes made here.{' '}
            <Button size="sm" onClick={() => void loadLatest()} disabled={query.isFetching}>
              Load latest
            </Button>
          </Note>
        ) : null}
        {/* A disabled fieldset makes every control inside read-only while Create runs. */}
        <fieldset
          disabled={creating}
          className="ui-stack"
          style={{ gap: 'var(--space-6)', border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <OverviewCard
            state={state}
            dispatch={dispatch}
            result={result}
            language={proposal.responseLanguage ?? result.detectedLanguage}
            translation={proposal.translation}
            onLanguage={(next) =>
              translate.mutate(next, {
                onError: (cause) => setError(normalizeError(cause).title),
              })
            }
          />
          <ModelSection
            state={state}
            dispatch={dispatch}
            fieldErrors={resolved.mapped}
            unmapped={resolved.unmapped}
          />
          <EndpointsSection state={state} dispatch={dispatch} />
          <AuthSection
            state={state}
            dispatch={dispatch}
            recommendation={result.authRecommendation}
          />
          {aiEntities ? <ChangesPanel original={aiEntities} current={state.entities} /> : null}
          <ActionBar
            saveStatus={saveState.status}
            canUndo={session.history.past.length > 0}
            canCreate={canCreate}
            creating={creating}
            onUndo={() => {
              if (!creating) dispatchSession({ type: 'undo' });
            }}
            onShowChanges={() => setShowChanges((v) => !v)}
            onRegenerate={() => {
              setError(null);
              // The server revises the saved draft, so it must hold the latest edits first.
              void saver.flush().then(
                () => setRegenerating(true),
                (cause: unknown) =>
                  setError(normalizeError(cause).title || 'Your changes could not be saved.'),
              );
            }}
            onCreate={() => void create()}
            onRetrySave={() => void saver.flush().catch(() => undefined)}
          />
        </fieldset>
        {state.authMode === null ? (
          <p className="ui-meta">Answer the authentication question to create the API.</p>
        ) : null}
        {clientIssues > 0 ? (
          <p className="ui-meta">
            {validateRelations(state.entities).length > 0
              ? 'Fix the highlighted relationships to create the API.'
              : 'Name every entity and give every enum field a value to create the API.'}
          </p>
        ) : null}
        {error ? <FormError title={error} /> : null}
        {regenerating ? (
          <RegenerateDialog
            open
            onClose={() => setRegenerating(false)}
            proposal={proposal}
            current={state}
            onAdopted={(child) => router.replace(`/new/ai/${child}`)}
          />
        ) : null}
      </div>
    </FlowScope>
  );
}

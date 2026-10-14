'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, FormError, Input, Select, Textarea } from '@instantmockapi/ui';
import {
  useAiProposal,
  useAiProposals,
  useCancelAiProposal,
  useCommitAiProposal,
  useCreateAiProposal,
  useRetryAiProposal,
} from '../../../lib/hooks';
import { normalizeError } from '../../../lib/errors';
import {
  RESPONSE_LANGUAGES,
  defaultResponseLanguage,
  examplesFor,
  responseLanguageFor,
  stageLabel,
} from '../../../lib/ai-proposal';

export default function NewAiPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState(defaultResponseLanguage());
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [kind, setKind] = useState<'project' | 'single' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateAiProposal();
  const retry = useRetryAiProposal();
  const cancel = useCancelAiProposal();
  const commit = useCommitAiProposal();
  const history = useAiProposals();
  const proposal = useAiProposal(proposalId).data;

  // An error belongs to the view it happened on (e.g. a 409 from cancel); drop it when the
  // displayed proposal or its status changes.
  useEffect(() => setError(null), [proposal?.id, proposal?.status]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(normalizeError(caught).title || 'Something went wrong.');
    }
  }

  const generate = () =>
    run(async () => {
      const view = await create.mutateAsync({
        prompt: prompt.trim(),
        name: name.trim() || undefined,
        responseLanguage: responseLanguageFor(language),
      });
      setKind(null);
      setProposalId(view.id);
    });

  // Always restore the prompt: the editor may be empty or stale (e.g. the proposal was opened from history).
  const backToEditor = (promptToRestore: string) => {
    setPrompt(promptToRestore);
    setProposalId(null);
    setKind(null);
  };

  // A committed proposal already owns a project (opened from history, or a commit that raced).
  const committedProjectId = proposal?.status === 'committed' ? proposal.projectId : null;
  useEffect(() => {
    if (committedProjectId) router.push(`/projects/${committedProjectId}`);
  }, [committedProjectId, router]);

  const createProject = () =>
    run(async () => {
      if (!proposal) return;
      try {
        const project = await commit.mutateAsync({
          proposalId: proposal.id,
          kind: kind ?? undefined,
        });
        router.push(`/projects/${project.id}`);
      } catch (caught) {
        // A 409 may mean it was already committed: refresh so the effect above can redirect.
        void queryClient.invalidateQueries({ queryKey: ['ai-proposal', proposal.id] });
        throw caught;
      }
    });

  // ── Generating ──────────────────────────────────────────────
  if (proposal && (proposal.status === 'generating' || proposal.status === 'committing')) {
    return (
      <div style={{ maxWidth: '760px' }}>
        <Card className="ui-stack">
          <h1>Building your API…</h1>
          <p className="ui-meta" role="status" aria-live="polite">
            {proposal.status === 'committing'
              ? 'Creating your project…'
              : stageLabel(proposal.stage)}
          </p>
          <p>{proposal.prompt}</p>
          {proposal.status === 'generating' ? (
            <div className="ui-row" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={() =>
                  run(async () => {
                    await cancel.mutateAsync(proposal.id);
                    backToEditor(proposal.prompt);
                  })
                }
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {error ? <FormError title={error} /> : null}
        </Card>
      </div>
    );
  }

  // ── Failed ──────────────────────────────────────────────────
  if (proposal && proposal.status === 'failed') {
    return (
      <div style={{ maxWidth: '760px' }}>
        <Card className="ui-stack">
          <h1>We couldn’t build that one</h1>
          <FormError
            title={proposal.error?.message ?? 'Generation failed.'}
            detail="Your prompt is kept below. Retry, or edit it and generate again."
          />
          <p>{proposal.prompt}</p>
          {proposal.error?.details?.length ? (
            <details>
              <summary>Technical details</summary>
              <ul>
                {proposal.error.details.map((detail) => (
                  <li key={`${detail.path}:${detail.issue}`}>
                    <code>{detail.path || '(root)'}</code>: {detail.issue}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="ui-row" style={{ justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
            <Button
              variant="secondary"
              onClick={() => {
                backToEditor(proposal.prompt);
              }}
            >
              Edit prompt
            </Button>
            <Button
              onClick={() => run(() => retry.mutateAsync(proposal.id))}
              disabled={retry.isPending}
            >
              Retry
            </Button>
          </div>
          {error ? <FormError title={error} /> : null}
        </Card>
      </div>
    );
  }

  // ── Ready: minimal summary (the full review editor is Sub-project 2) ──
  if (proposal && proposal.status === 'ready' && proposal.result) {
    const result = proposal.result;
    const chosenKind = kind ?? proposal.hints.kind ?? result.recommendedKind;
    return (
      <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: '760px' }}>
        <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
          <h1>{result.name}</h1>
          <p className="ui-meta">{result.description}</p>
        </div>

        <Card className="ui-stack">
          <Field label="API type">
            <Select
              value={chosenKind}
              onChange={(event) => setKind(event.target.value as 'project' | 'single')}
            >
              <option value="project">Project — several related resources</option>
              <option value="single">Single — one focused resource</option>
            </Select>
          </Field>
          <p className="ui-meta">
            <Badge>Recommended: {result.recommendedKind}</Badge> {result.kindRationale}
          </p>
        </Card>

        <Card className="ui-stack">
          <h2>Entities ({result.entities.length})</h2>
          <ul>
            {result.entities.map((entity) => (
              <li key={entity.name}>
                <strong>{entity.name}</strong> — {entity.fields.length} fields
                {entity.description ? (
                  <span className="ui-meta"> · {entity.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        {result.assumptions.length > 0 ? (
          <Card className="ui-stack">
            <h2>Assumptions</h2>
            <ul>
              {result.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        {result.questions.length > 0 ? (
          <Card className="ui-stack">
            <h2>Questions to consider</h2>
            <ul>
              {result.questions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="ui-row" style={{ justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          <Button
            variant="secondary"
            onClick={() => {
              backToEditor(proposal.prompt);
            }}
          >
            Start over
          </Button>
          <Button onClick={createProject} disabled={commit.isPending}>
            {commit.isPending ? 'Creating…' : 'Create API'}
          </Button>
        </div>
        {error ? <FormError title={error} /> : null}
      </div>
    );
  }

  // ── Describe (also shown after cancel) ──────────────────────
  const examples = examplesFor(language);
  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)', maxWidth: '760px' }}>
      <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
        <h1>Create API with AI</h1>
        <p className="ui-meta">
          Describe any API, in any language. The AI proposes the data model; the platform validates
          it before anything is created.
        </p>
      </div>

      <Card className="ui-stack">
        <Field label="Describe the API you want to build">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={8}
            maxLength={1000}
            placeholder="Describe the API you want to build…"
          />
        </Field>
        <div className="ui-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {examples.map((example) => (
            <Button key={example} variant="secondary" size="sm" onClick={() => setPrompt(example)}>
              {example}
            </Button>
          ))}
        </div>
        <Field label="Project name (optional)">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </Field>
        <Field label="Explain the result in">
          <Select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {RESPONSE_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="ui-row" style={{ justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          <Button variant="secondary" onClick={() => router.back()}>
            Back
          </Button>
          <Button onClick={generate} disabled={create.isPending || !prompt.trim()}>
            {create.isPending ? 'Starting…' : 'Generate API'}
          </Button>
        </div>
        {error ? (
          <FormError title={error} detail="Please refine the prompt and try again." />
        ) : null}
      </Card>

      {history.data?.data.length ? (
        <Card className="ui-stack">
          <h2>Recent prompts</h2>
          <ul>
            {history.data.data.map((item) => (
              <li key={item.id}>
                {/* No `ui-link` class exists in the theme; a ghost button is the closest variant. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    item.status === 'cancelled' ? setPrompt(item.prompt) : setProposalId(item.id)
                  }
                >
                  {item.name ?? item.prompt.slice(0, 80)}
                </Button>{' '}
                <span className="ui-meta">· {item.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

'use client';

import type { Dispatch } from 'react';
import { Badge, Card, Field, Input, Note, Select, Textarea } from '@instantmockapi/ui';
import type { AiProposalResult, AiProposalView } from '../../lib/api-types';
import { RESPONSE_LANGUAGES } from '../../lib/ai-proposal';
import type { ReviewAction, ReviewState } from '../../lib/review-state';

export function OverviewCard({
  state,
  dispatch,
  result,
  language,
  translation,
  onLanguage,
}: {
  state: ReviewState;
  dispatch: Dispatch<ReviewAction>;
  result: AiProposalResult;
  language: string;
  translation: AiProposalView['translation'];
  onLanguage: (language: string) => void;
}) {
  const languages = RESPONSE_LANGUAGES.filter((option) => option.code !== 'auto');
  return (
    <Card className="ui-stack">
      <Field label="API name">
        <Input
          value={state.name}
          maxLength={120}
          onChange={(e) => dispatch({ type: 'name', value: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <Textarea
          value={state.description}
          maxLength={500}
          rows={3}
          onChange={(e) => dispatch({ type: 'description', value: e.target.value })}
        />
      </Field>
      <Field label="API type">
        <Select
          value={state.kind}
          onChange={(e) => {
            const value = e.target.value as 'project' | 'single';
            if (
              value === 'single' &&
              state.entities.some((entity) => entity.relations.length > 0) &&
              !window.confirm(
                'Single APIs have no relationships. Remove them? (Undo brings them back.)',
              )
            ) {
              return;
            }
            dispatch({ type: 'kind', value });
          }}
        >
          <option value="project">Project — several related resources</option>
          <option value="single">Single — one focused resource</option>
        </Select>
      </Field>
      <p className="ui-meta">
        <Badge>Recommended: {result.recommendedKind}</Badge> {result.kindRationale}
      </p>
      <Field label="Explain the result in">
        <Select
          value={translation?.status === 'pending' ? translation.language : language}
          onChange={(e) => onLanguage(e.target.value)}
        >
          {languages.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {translation?.status === 'pending' ? (
        <p className="ui-meta" role="status">
          Translating…
        </p>
      ) : null}
      {translation?.status === 'failed' ? (
        <Note variant="warning">
          {translation.message ?? 'Translation failed – keep this language or retry'}
        </Note>
      ) : null}
      {result.assumptions.length > 0 ? (
        <div className="ui-stack">
          <h3>Assumptions</h3>
          <ul>
            {result.assumptions.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.questions.length > 0 ? (
        <div className="ui-stack">
          <h3>Questions to consider</h3>
          <ul>
            {result.questions.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

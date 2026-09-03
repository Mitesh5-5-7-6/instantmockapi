'use client';

/**
 * The review-changes panel: what this edit does, before it is committed.
 *
 * ## It renders, it does not calculate
 *
 * Every number, list and reason string here comes from
 * `GET /v1/projects/:id/draft/impact`. The diff, the dependency graph and the
 * impact rules live in `@instantmockapi/ips` and are enforced by the commit
 * endpoint. A second implementation in the browser would eventually disagree
 * with the one that actually gates the commit, and the user would be shown two
 * different answers to the same question — believing whichever they read second.
 *
 * So this component owns exactly one piece of state: which optional artifacts
 * are ticked.
 *
 * ## The no-impact list is the point
 *
 * Listing what breaks is easy and unconvincing on its own — a reader cannot tell
 * a precise report from a lazy one that flagged everything. Showing
 * `DELETE /user/{id}` under "No impact" is the claim being made, and it is what
 * makes the affected list worth reading.
 */

import { useMemo, useState } from 'react';
import { Card, Checkbox, FormError, MethodBadge, Note, type ApiMethod } from '@instantmockapi/ui';
import type {
  AffectedEndpoint,
  ChangeRisk,
  DraftAnalysis,
  ImpactReason,
} from '../../lib/api-types';

/**
 * Artifacts the runtime needs versus the ones it does not.
 *
 * `hosted_api` is what serves traffic, so it is never optional — offering to skip
 * it would let a user commit a definition the live API does not implement. The
 * rest are documentation and generated code: valuable, but a failed OpenAPI build
 * must not be able to hold up a working mock API.
 *
 * Mirrors `RUNTIME_REQUIRED_ARTIFACTS` in `@instantmockapi/shared`, which is what
 * the promotion gate actually enforces. `ips` is deliberately not here — it is
 * API-managed and never appears in an impact report at all.
 */
const REQUIRED_ARTIFACTS = new Set(['hosted_api']);

const ARTIFACT_LABELS: Record<string, string> = {
  hosted_api: 'Hosted API',
  openapi: 'OpenAPI',
  postman: 'Postman',
  typescript: 'TypeScript',
  zod: 'Zod',
  yup: 'Yup',
  json_schema: 'JSON Schema',
  mock_data: 'Mock data',
  export_zip: 'Export ZIP',
};

/**
 * Wording for each risk level.
 *
 * `WARNING` reads as "needs attention" rather than "warning" because the
 * distinction it carries is *some* callers break, depending on what they send —
 * which is a thing to go and check, not a thing to shrug at.
 */
const RISK_WORDS: Record<ChangeRisk, string> = {
  SAFE: 'Safe',
  INFO: 'Info',
  WARNING: 'Needs attention',
  ROUTING: 'URL moves',
  BREAKING: 'Breaking',
};

/** Plain-English gloss per facet, so `request.body.email` is not the only cue. */
const FACET_WORDS: Record<ImpactReason['facet'], string> = {
  request: 'Request body',
  response: 'Response body',
  query: 'Query string',
  path: 'URL path',
};

const HTTP_METHODS = new Set<ApiMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Render a method badge, falling back to plain text for anything unrecognised.
 *
 * The API returns the method as a string; `MethodBadge` takes a closed union. A
 * cast would render an unstyled badge for a method added server-side later, so
 * the fallback is explicit.
 */
function Method({ method }: { method: string }) {
  return HTTP_METHODS.has(method as ApiMethod) ? (
    <MethodBadge method={method as ApiMethod} />
  ) : (
    <span className="ui-mono">{method}</span>
  );
}

function RiskChip({ risk }: { risk: ChangeRisk }) {
  return (
    <span className={`review-risk review-risk--${risk.toLowerCase()}`}>{RISK_WORDS[risk]}</span>
  );
}

/** One affected endpoint and every reason it is affected. */
function AffectedRow({ endpoint }: { endpoint: AffectedEndpoint }) {
  return (
    <li className="review-endpoint">
      <div className="review-endpoint__head">
        <Method method={endpoint.method} />
        <code className="ui-mono">{endpoint.path}</code>
        <RiskChip risk={endpoint.risk} />
      </div>
      <ul className="review-reasons">
        {endpoint.reasons.map((reason) => (
          <li key={`${reason.change}:${reason.reason}`}>
            <strong>{reason.source}</strong>
            <span>{reason.summary}</span>
            <span className="ui-meta">{FACET_WORDS[reason.facet]}</span>
            <code className="ui-mono">{reason.reason}</code>
          </li>
        ))}
      </ul>
    </li>
  );
}

export interface ReviewChangesProps {
  analysis: DraftAnalysis;
  /** Called with the artifacts to regenerate and the digest being acknowledged. */
  onConfirm: (input: { artifacts: string[]; acknowledgeImpact: string }) => void;
  onCancel: () => void;
  busy?: boolean;
  /** Server-side failure, shown verbatim rather than reworded. */
  error?: string | null;
}

export function ReviewChanges({
  analysis,
  onConfirm,
  onCancel,
  busy = false,
  error = null,
}: ReviewChangesProps) {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());

  const optional = useMemo(
    () => analysis.artifacts.filter((artifact) => !REQUIRED_ARTIFACTS.has(artifact)),
    [analysis.artifacts],
  );

  const toggle = (artifact: string): void => {
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(artifact)) {
        next.delete(artifact);
      } else {
        next.add(artifact);
      }
      return next;
    });
  };

  const selected = analysis.artifacts.filter((artifact) => !skipped.has(artifact));
  const attention = analysis.summary.WARNING + analysis.summary.ROUTING + analysis.summary.BREAKING;

  if (analysis.changes.length === 0) {
    return (
      <Card className="ui-stack">
        <h2>No changes</h2>
        <p className="ui-meta">
          This draft matches the current definition, so there is nothing to commit and nothing to
          regenerate.
        </p>
        <div className="ui-row">
          <button type="button" className="ui-btn" onClick={onCancel}>
            Close
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="ui-stack review">
      <header className="ui-stack ui-stack--tight">
        <h2>Review changes</h2>
        <p className="ui-meta">
          {analysis.changes.length} {analysis.changes.length === 1 ? 'change' : 'changes'} ·{' '}
          {analysis.affected.length} {analysis.affected.length === 1 ? 'API' : 'APIs'} affected
          {attention > 0 ? ` · ${attention} needing attention` : ''}
        </p>
        {analysis.risk !== null && <RiskChip risk={analysis.risk} />}
      </header>

      {/* Staleness is fatal to a commit, so it is stated before anything else. */}
      {analysis.stale && (
        <Note variant="warning">
          This draft was started from v{analysis.baseVersion}, but the project has since moved to v
          {analysis.currentVersion}. The comparison below describes a definition that no longer
          exists — re-fork the draft to review your edits against the current one.
        </Note>
      )}

      {/*
        Honesty about the limits of the analysis. `incomplete` means a change
        could not be matched to a graph node, which happens on a definition that
        predates stable ids. Without this notice the no-impact list would read as
        a guarantee the report cannot make.
      */}
      {analysis.incomplete && (
        <Note variant="warning">
          Some changes could not be traced to a specific API, so the “No impact” list below may be
          incomplete.
        </Note>
      )}

      <section className="ui-stack ui-stack--tight">
        <h3>What changed</h3>
        <ul className="review-changes">
          {analysis.changes.map((change, index) => (
            <li key={`${change.kind}:${change.entity ?? ''}:${change.field ?? ''}:${index}`}>
              <RiskChip risk={change.risk} />
              <strong>
                {change.entity}
                {change.field !== null ? `.${change.path ?? change.field}` : ''}
              </strong>
              <span>{change.summary}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="ui-stack ui-stack--tight">
        <h3>Affected APIs</h3>
        {analysis.affected.length === 0 ? (
          <p className="ui-meta">
            No endpoint changes shape. These edits affect generated output only.
          </p>
        ) : (
          <ul className="review-endpoints">
            {analysis.affected.map((endpoint) => (
              <AffectedRow key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} />
            ))}
          </ul>
        )}
      </section>

      {analysis.unaffected.length > 0 && (
        <section className="ui-stack ui-stack--tight">
          <h3>No impact</h3>
          <p className="ui-meta">
            These keep working exactly as they do now, and will not be changed.
          </p>
          <ul className="review-endpoints review-endpoints--quiet">
            {analysis.unaffected.map((endpoint) => (
              <li key={`${endpoint.method} ${endpoint.path}`} className="review-endpoint__head">
                <Method method={endpoint.method} />
                <code className="ui-mono">{endpoint.path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ui-stack ui-stack--tight">
        <h3>Regenerate</h3>
        <ul className="review-artifacts">
          {analysis.artifacts.map((artifact) => {
            const required = REQUIRED_ARTIFACTS.has(artifact);
            return (
              <li key={artifact}>
                <Checkbox
                  checked={required || !skipped.has(artifact)}
                  disabled={required || busy}
                  onChange={() => toggle(artifact)}
                  label={`${ARTIFACT_LABELS[artifact] ?? artifact}${required ? ' (required)' : ''}`}
                />
              </li>
            );
          })}
        </ul>
        {optional.length > 0 && skipped.size > 0 && (
          <Note variant="warning">
            Skipped artifacts keep their previous version, which will describe the old schema until
            you regenerate them.
          </Note>
        )}
      </section>

      {error !== null && <FormError title={error} />}

      <footer className="ui-row ui-row--between">
        {/*
          The invariant, said out loud where the decision is made. Users have been
          trained by other tools to expect "save" to mean "deploy".
        */}
        <span className="ui-meta">
          Your live API keeps serving v{analysis.currentVersion} until the new version has been
          generated and promoted.
        </span>
        <span className="ui-row">
          <button type="button" className="ui-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--primary"
            disabled={busy || analysis.stale || selected.length === 0}
            onClick={() => onConfirm({ artifacts: selected, acknowledgeImpact: analysis.digest })}
          >
            {busy ? 'Committing…' : 'Commit and regenerate'}
          </button>
        </span>
      </footer>
    </Card>
  );
}

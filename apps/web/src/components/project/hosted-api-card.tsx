'use client';

/**
 * The hosted API: its URL, when it expires, and what it accepts.
 *
 * This is the slot the target design fills with an "Environment" card listing
 * Production and Development base URLs. **Neither exists** — there is one hosted
 * URL per project in the schema, the runtime, and the generator. Rather than
 * render two rows where one is fiction, this shows the real URL plus two things
 * the old page never surfaced anywhere: the enabled HTTP methods, and the enabled
 * query features.
 */

import {
  Button,
  CountdownBadge,
  EmptyState,
  Icon,
  MethodBadge,
  type ApiMethod,
} from '@instantmockapi/ui';
import type { ProjectDetail, QueryFeatures } from '../../lib/api-types';

const QUERY_LABELS: Record<keyof QueryFeatures, string> = {
  search: 'search',
  filter: 'filter',
  sort: 'sort',
  include: 'include',
};

/** Copy button that confirms, because a silent copy leaves you unsure it worked. */
function CopyUrl({ url }: { url: string }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(url);
      }}
    >
      <Icon name="copy" size={14} /> Copy
    </Button>
  );
}

export function HostedApiCard({
  detail,
  onGenerate,
  generating,
}: {
  detail: ProjectDetail;
  onGenerate: () => void;
  generating: boolean;
}) {
  const url = detail.hosted.url;
  const methods = detail.generationConfig.methods;
  // Absent on every project generated before the query layer, which resolves to
  // "all off" rather than undefined.
  const features = detail.generationConfig.features;
  const enabled = features
    ? (Object.keys(QUERY_LABELS) as (keyof QueryFeatures)[]).filter((key) => features[key])
    : [];

  if (!url) {
    return (
      <div className="ui-card">
        <EmptyState title="Not hosted yet">
          Generate this project to bring its mock API up.{' '}
          {methods.length === 0 ? 'Select at least one HTTP method first.' : ''}
          <div className="ui-row" style={{ marginTop: 'var(--space-4)' }}>
            <Button onClick={onGenerate} disabled={generating || methods.length === 0}>
              {generating ? 'Starting…' : 'Generate'}
            </Button>
          </div>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="ui-card hosted-card">
      <div className="ui-row ui-row--between hosted-card__head">
        <h2>Hosted API</h2>
        <CountdownBadge expiresAt={detail.hosted.expiresAt} />
      </div>

      {/* The URL is the single most useful thing on this page, so it gets the
          full width and a monospace face — it is meant to be read character by
          character and pasted. */}
      <div className="hosted-card__url">
        <code>{url}</code>
        <CopyUrl url={url} />
      </div>

      <dl className="hosted-card__facts">
        <div>
          <dt>Methods</dt>
          <dd className="ui-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            {methods.length === 0 ? (
              <span className="ui-meta">none enabled</span>
            ) : (
              methods.map((method) => <MethodBadge key={method} method={method as ApiMethod} />)
            )}
          </dd>
        </div>
        <div>
          <dt>Query</dt>
          <dd>
            {enabled.length === 0 ? (
              // Not an error — it is the default, and every project predating the
              // query layer reads this way.
              <span className="ui-meta">none enabled</span>
            ) : (
              <span className="ui-mono ui-meta">
                {enabled.map((key) => QUERY_LABELS[key]).join(' · ')}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

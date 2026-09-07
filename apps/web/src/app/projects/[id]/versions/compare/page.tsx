'use client';

/**
 * Comparing two versions (Phase 2 §14, §15, §24, §36, §37).
 *
 * ## It renders; it does not compute
 *
 * Every number, group and classification on this page comes from
 * `GET /versions/compare`, which runs `packages/ips`. `ARCHITECTURE.md` is
 * explicit about why: *"a second implementation in the frontend would eventually
 * disagree with the backend about what a change means, and the user would be
 * shown two different answers to the same question."*
 *
 * ## Only one of the two axes appears here
 *
 * The three-value `impact` — do callers break. Not `risk`, which the commit
 * dialog shows. Eight of the change kinds legitimately disagree between them
 * (a changed default is `SAFE` *and* potentially breaking), so putting both in
 * one row reads as a contradiction.
 *
 * ## Colour
 *
 * A glyph plus a chip, never colour alone (§34) — and never a filled row. A
 * 400-change diff of red and green blocks is unreadable, and it would blow the
 * theme's green budget in a single screen.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Note,
  Select,
  StatusChip,
  buttonVariants,
} from '@instantmockapi/ui';
import { useProject, useVersionComparison, useVersions } from '../../../../../lib/hooks';
import type {
  EntityGroupView,
  FieldGroupView,
  GroupedChangeView,
  RelationGroupView,
} from '../../../../../lib/api-types';
import {
  CHANGE_GLYPH,
  GROUP_GLYPH,
  IMPACT_CHIP,
  IMPACT_LABEL,
  directionHeading,
  emptyStateMessage,
  matchingNotice,
  summaryLine,
  valuePair,
} from '../../../../../lib/diff-view';

/** One before/after pair, side by side (§15). */
function ValuePanel({ entry }: { entry: GroupedChangeView }) {
  const pair = valuePair(entry.change);

  // Nothing to compare — an add or a remove has only one side, and showing an
  // empty "Before" box would imply it used to hold something.
  if (pair.before === null && pair.after === null) {
    return null;
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] tracking-wide text-subtle-foreground uppercase">Before</span>
        <code className="rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs break-all">
          {pair.before ?? '—'}
        </code>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] tracking-wide text-subtle-foreground uppercase">After</span>
        <code className="rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs break-all">
          {pair.after ?? '—'}
        </code>
      </div>
      {pair.truncated ? (
        <span className="text-xs text-muted-foreground sm:col-span-2">
          One of these values was too large to send in full and is shown truncated.
        </span>
      ) : null}
    </div>
  );
}

function ChangeRow({ entry }: { entry: GroupedChangeView }) {
  return (
    <li className="flex flex-col gap-2 border-b border-border/50 py-2 last:border-0">
      <div className="flex items-start gap-2">
        {/* The glyph carries the shape; the chip carries the severity; the text
            stays neutral. Colour is never the only signal. */}
        <span aria-hidden className="w-3 shrink-0 font-mono text-sm text-muted-foreground">
          {CHANGE_GLYPH[entry.changeType]}
        </span>
        <span className="min-w-0 flex-1 text-sm">{entry.change.summary}</span>
        <StatusChip status={IMPACT_CHIP[entry.impact]} label={IMPACT_LABEL[entry.impact]} />
      </div>
      <ValuePanel entry={entry} />
    </li>
  );
}

function GroupHeader({
  glyph,
  name,
  previousName,
  count,
  matchedBy,
}: {
  glyph: string;
  name: string;
  previousName: string | null;
  count: number;
  matchedBy: 'id' | 'name';
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden className="font-mono text-sm text-muted-foreground">
        {glyph}
      </span>
      <span className="font-mono text-sm">
        {previousName === null ? name : `${previousName} → ${name}`}
      </span>
      <span className="text-xs text-subtle-foreground">
        {count} {count === 1 ? 'change' : 'changes'}
      </span>
      {matchedBy === 'name' ? (
        // The badge belongs on the group that earned it, not over the page:
        // one uncertain entity of twelve must not caveat the other eleven.
        <Badge variant="neutral">Matched by name</Badge>
      ) : null}
    </div>
  );
}

function FieldGroup({ group }: { group: FieldGroupView }) {
  return (
    <details className="rounded-sm border border-border px-3 py-2">
      <summary className="cursor-pointer">
        <GroupHeader
          glyph={GROUP_GLYPH[group.status]}
          name={group.path}
          previousName={group.previousName}
          count={group.counts.total}
          matchedBy={group.matchedBy}
        />
      </summary>
      <ul className="mt-2 flex flex-col">
        {group.changes.map((entry, index) => (
          <ChangeRow key={`${entry.change.kind}:${index}`} entry={entry} />
        ))}
      </ul>
    </details>
  );
}

function RelationGroup({ group }: { group: RelationGroupView }) {
  return (
    <details className="radius-sm border border-border px-3 py-2">
      <summary className="cursor-pointer">
        <GroupHeader
          glyph={GROUP_GLYPH[group.status]}
          name={group.name}
          previousName={group.previousName}
          count={group.counts.total}
          matchedBy={group.matchedBy}
        />
      </summary>
      <ul className="mt-2 flex flex-col">
        {group.changes.map((entry, index) => (
          <ChangeRow key={`${entry.change.kind}:${index}`} entry={entry} />
        ))}
      </ul>
    </details>
  );
}

/** §37's hierarchy: entity → fields / relations / APIs. */
function EntityGroup({ group }: { group: EntityGroupView }) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <GroupHeader
          glyph={GROUP_GLYPH[group.status]}
          name={group.name}
          previousName={group.previousName}
          count={group.counts.total}
          matchedBy={group.matchedBy}
        />
        <StatusChip status={IMPACT_CHIP[group.impact]} label={IMPACT_LABEL[group.impact]} />
      </div>

      {group.own.length > 0 ? (
        <ul className="flex flex-col">
          {group.own.map((entry, index) => (
            <ChangeRow key={`${entry.change.kind}:${index}`} entry={entry} />
          ))}
        </ul>
      ) : null}

      {group.fields.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Fields</span>
          {group.fields.map((field) => (
            <FieldGroup key={field.key} group={field} />
          ))}
        </div>
      ) : null}

      {group.relations.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Relations</span>
          {group.relations.map((relation) => (
            <RelationGroup key={relation.key} group={relation} />
          ))}
        </div>
      ) : null}

      {group.endpoints.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">APIs affected</span>
          <div className="flex flex-wrap gap-2">
            {group.endpoints.map((endpoint) => (
              <code
                key={`${endpoint.method} ${endpoint.path}`}
                className="font-mono text-xs text-muted-foreground"
              >
                {endpoint.method} {endpoint.path}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      {group.omittedChanges > 0 ? (
        <span className="text-xs text-warning">
          +{group.omittedChanges} more changes in this entity, not shown.
        </span>
      ) : null}
    </Card>
  );
}

export default function ComparePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();

  const project = useProject(id);
  const versions = useVersions(id);

  const rows = versions.data?.data ?? [];
  const newest = rows[0]?.version ?? null;
  const published = project.data?.publishedVersion ?? null;

  /**
   * The pair, from the URL so a comparison is shareable.
   *
   * Defaults to "the live version against the newest", which is the comparison
   * a user opening this page almost always wants: what is waiting to go out.
   */
  const fromParam = Number(params.get('from'));
  const toParam = Number(params.get('to'));
  const from = Number.isInteger(fromParam) && fromParam > 0 ? fromParam : (published ?? null);
  const to = Number.isInteger(toParam) && toParam > 0 ? toParam : newest;

  const [pending, setPending] = useState<{ from: number | null; to: number | null }>({
    from: null,
    to: null,
  });
  const selectedFrom = pending.from ?? from;
  const selectedTo = pending.to ?? to;

  const comparison = useVersionComparison(id, selectedFrom, selectedTo);

  const notice = useMemo(
    () => (comparison.data ? matchingNotice(comparison.data.matching) : null),
    [comparison.data],
  );

  const apply = (next: { from: number | null; to: number | null }): void => {
    setPending(next);
    if (next.from !== null && next.to !== null) {
      router.replace(`/projects/${id}/versions/compare?from=${next.from}&to=${next.to}`);
    }
  };

  const options = rows.map((row) => row.version);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Compare versions</h2>
            <span className="text-xs text-muted-foreground">
              Any two versions, in either direction.
            </span>
          </div>
          <Link
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            href={`/projects/${id}/versions`}
          >
            Back to versions
          </Link>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="compare-from">
            <Select
              id="compare-from"
              value={selectedFrom ?? ''}
              onChange={(event) => apply({ from: Number(event.target.value), to: selectedTo })}
            >
              {options.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </Select>
          </Field>
          <span aria-hidden className="pb-2 text-muted-foreground">
            →
          </span>
          <Field label="To" htmlFor="compare-to">
            <Select
              id="compare-to"
              value={selectedTo ?? ''}
              onChange={(event) => apply({ from: selectedFrom, to: Number(event.target.value) })}
            >
              {options.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </Select>
          </Field>
          {selectedFrom !== null && selectedFrom === selectedTo ? (
            <span className="pb-2 text-xs text-muted-foreground">Pick two different versions.</span>
          ) : null}
        </div>
      </Card>

      {comparison.isError ? (
        <ErrorState
          title="Could not compare these versions"
          onRetry={() => void comparison.refetch()}
        />
      ) : comparison.isPending ? (
        <div className="h-40 animate-pulse rounded-md bg-muted" />
      ) : comparison.data === undefined ? null : (
        <>
          {/* §36's summary. The counts are computed over the FULL change set,
              even when the body below is capped — so this header stays true. */}
          <Card className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold">{directionHeading(comparison.data)}</h3>
              <span className="text-sm text-muted-foreground">{summaryLine(comparison.data)}</span>
            </div>

            {comparison.data.summary.total > 0 ? (
              <div className="flex flex-wrap gap-2">
                {comparison.data.summary.impact.BREAKING > 0 ? (
                  <StatusChip
                    status="failed"
                    label={`${comparison.data.summary.impact.BREAKING} breaking`}
                  />
                ) : null}
                {comparison.data.summary.impact.POTENTIALLY_BREAKING > 0 ? (
                  <StatusChip
                    status="generating"
                    label={`${comparison.data.summary.impact.POTENTIALLY_BREAKING} may break callers`}
                  />
                ) : null}
                {comparison.data.summary.impact.NON_BREAKING > 0 ? (
                  <StatusChip
                    status="ready"
                    label={`${comparison.data.summary.impact.NON_BREAKING} safe`}
                  />
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>{comparison.data.summary.affectedEntities} entities</span>
              <span>{comparison.data.summary.affectedEndpoints} endpoints</span>
              <span>{comparison.data.summary.affectedArtifacts} artifacts</span>
            </div>

            {comparison.data.from.source === 'project' ||
            comparison.data.to.source === 'project' ? (
              <Note>
                One side of this comparison is the current working definition rather than a stored
                snapshot, because that version has not been generated yet.
              </Note>
            ) : null}

            {/* The page-level warning, only when the whole comparison rests on
                names. A caveat on a confident diff trains people to ignore the
                one that matters. */}
            {notice?.level === 'page' ? (
              <Note variant="warning">{notice.message}</Note>
            ) : notice?.level === 'entity' ? (
              <Note>{notice.message}</Note>
            ) : null}

            {comparison.data.incomplete ? (
              <Note variant="warning">
                Some changes could not be attributed to an endpoint, so the affected-API list below
                is not a complete guarantee.
              </Note>
            ) : null}

            {comparison.data.truncated ? (
              <Note variant="warning">
                This comparison is large: {comparison.data.truncated.omittedChanges} changes
                {comparison.data.truncated.omittedEntities > 0
                  ? ` across ${comparison.data.truncated.omittedEntities} entities`
                  : ''}{' '}
                are not shown. The counts above cover all of them.
              </Note>
            ) : null}
          </Card>

          {comparison.data.summary.total === 0 ? (
            <EmptyState title="No changes">{emptyStateMessage(comparison.data)}</EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              {comparison.data.tree.entities.map((entity) => (
                <EntityGroup key={entity.key} group={entity} />
              ))}

              {comparison.data.tree.project.changes.length > 0 ? (
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">Project configuration</span>
                    {comparison.data.tree.project.impact === null ? null : (
                      <StatusChip
                        status={IMPACT_CHIP[comparison.data.tree.project.impact]}
                        label={IMPACT_LABEL[comparison.data.tree.project.impact]}
                      />
                    )}
                  </div>
                  <ul className="flex flex-col">
                    {comparison.data.tree.project.changes.map((entry, index) => (
                      <ChangeRow key={`${entry.change.kind}:${index}`} entry={entry} />
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

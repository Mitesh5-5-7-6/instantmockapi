'use client';

/**
 * The Versions tab (Phase 2 §4–§6, §9).
 *
 * ## What this screen is for
 *
 * Two questions, in this order: *what is live right now*, and *what else exists*.
 * The current version gets its own panel because it is the only row whose answer
 * a caller of the hosted API can feel.
 *
 * ## Where publishing happens
 *
 * Here, and only here. Generation stops at READY — so this tab is the one place
 * the live pointer moves, which is why the confirmation is a `Modal` rather than
 * an inline button state: replacing what production serves deserves a deliberate
 * second action, and §8 requires one outright when the change is breaking.
 *
 * ## Colour
 *
 * A status dot with a neutral label, per the theme's rule that vividness scales
 * inversely with area. Twelve version rows would otherwise be twelve coloured
 * words; the dot carries the state and the text stays readable. `StatusChip`
 * already enforces this, so these rows use it rather than restyling.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CountdownBadge,
  EmptyState,
  ErrorState,
  Icon,
  Modal,
  Note,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  buttonVariants,
  tableNumeric,
} from '@instantmockapi/ui';
import {
  usePublishVersion,
  useProject,
  useVersions,
  type VersionView,
} from '../../../../lib/hooks';
import { useAction } from '../../../../lib/use-action';
import { formatAgo } from '../../../../lib/relative-time';
import {
  describeChangeType,
  summariseVersion,
  toVersionRow,
  type VersionRowView,
} from '../../../../lib/versions';

/** The dot colour a status chip already knows how to draw. */
const CHIP_STATUS: Record<string, string> = {
  live: 'live',
  ready: 'ready',
  progress: 'generating',
  failed: 'failed',
  neutral: 'draft',
};

/**
 * Which pair a row's Compare opens.
 *
 * Against the live version, because "what would change if I published this" is
 * the question the button is being asked from a version list. The live row has
 * nothing to compare itself to, so it falls back to the newest — and if there
 * is no live version at all, to v1.
 */
function compareHref(
  projectId: string,
  version: number,
  publishedVersion: number | null,
  newest: number | null,
): string {
  const other =
    publishedVersion !== null && publishedVersion !== version
      ? publishedVersion
      : newest !== null && newest !== version
        ? newest
        : 1;
  return `/projects/${projectId}/versions/compare?from=${other}&to=${version}`;
}

function VersionMeta({ version }: { version: VersionView }) {
  const changeType = describeChangeType(version);
  const summary = summariseVersion(version);
  // The recorded counts when there are any, else the human note. Never both —
  // they say the same thing at different resolutions.
  const detail = summary ?? version.note;

  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">
        {formatAgo(version.createdAt)}
        {changeType === null ? '' : ` · ${changeType}`}
      </span>
      {detail === null || detail === '' ? null : (
        <span className="text-xs text-subtle-foreground">{detail}</span>
      )}
    </span>
  );
}

export default function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const versions = useVersions(id);

  /** The version awaiting confirmation, or null when no dialog is open. */
  const [confirming, setConfirming] = useState<VersionRowView | null>(null);

  const publish = useAction(usePublishVersion(id), {
    loading: 'Publishing version…',
    // The no-op case must not claim to have done something: re-publishing the
    // live version is a success, and saying "is now live" would be a lie about
    // an action that did nothing.
    success: (result, version) =>
      result.published ? `Version v${version} is now live` : `v${version} is already live`,
    // Close the dialog on failure, so the toast is not competing with a modal
    // still offering the button that just failed.
    onFailure: () => setConfirming(null),
  });

  const publishedVersion = project.data?.publishedVersion ?? null;
  const rows = useMemo(
    () => (versions.data?.data ?? []).map((version) => toVersionRow(version, publishedVersion)),
    [versions.data, publishedVersion],
  );
  const byVersion = useMemo(
    () => new Map((versions.data?.data ?? []).map((version) => [version.version, version])),
    [versions.data],
  );

  const newest = rows.length === 0 ? null : Math.max(...rows.map((row) => row.version));
  const live = rows.find((row) => row.isLive) ?? null;
  const history = rows.filter((row) => !row.isLive);

  const confirmPublish = (row: VersionRowView): void => {
    setConfirming(row);
  };

  const runPublish = (version: number): void => {
    setConfirming(null);
    publish.run(version);
  };

  if (versions.isError) {
    return (
      <ErrorState title="Could not load version history" onRetry={() => void versions.refetch()} />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* §9's live-version indicator. Its own panel because it is the only row
          whose state a caller of the hosted API can feel. */}
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Live version</h2>
            <span className="text-xs text-muted-foreground">
              What the hosted API serves right now. Editing and generating never change it.
            </span>
          </div>
          {publishedVersion === null ? (
            <StatusChip status="draft" label="Nothing published" />
          ) : (
            <span className="flex items-center gap-2">
              <Badge>v{publishedVersion}</Badge>
              <StatusChip status="live" label="Live" />
            </span>
          )}
        </div>

        {project.data?.hosted.url ? (
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-mono text-xs break-all text-accent-text">
              {project.data.hosted.url}
            </code>
            <CountdownBadge expiresAt={project.data.hosted.expiresAt} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            No hosted URL yet — generate this project, then publish the version that succeeds.
          </span>
        )}

        {project.data?.pendingRegeneration === true ? (
          <Note>
            The definition has moved to v{project.data.currentVersion} since v{publishedVersion}{' '}
            went live. Generate it, then publish the result — until you do, callers keep getting v
            {publishedVersion}.
          </Note>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">History</h2>
          <span className="text-xs text-muted-foreground">
            Every version is an immutable snapshot. Nothing here is ever rewritten or deleted.
          </span>
        </div>

        {versions.isPending ? (
          <div className="h-24 animate-pulse rounded-md bg-muted" />
        ) : rows.length === 0 ? (
          <EmptyState title="No versions yet">
            Your first generated project version will appear here.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="max-lg:hidden">Details</TableHead>
                <TableHead className={tableNumeric}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...(live ? [live] : []), ...history].map((row) => {
                const version = byVersion.get(row.version);
                return (
                  <TableRow key={row.version}>
                    <TableRowHeader>
                      <span className="flex items-center gap-2">
                        v{row.version}
                        {row.isLive ? <Icon name="check" size={14} label="Live version" /> : null}
                      </span>
                    </TableRowHeader>
                    <TableCell>
                      <StatusChip status={CHIP_STATUS[row.tone] ?? 'draft'} label={row.label} />
                    </TableCell>
                    <TableCell className="max-lg:hidden">
                      {version ? <VersionMeta version={version} /> : null}
                    </TableCell>
                    <TableCell className={tableNumeric}>
                      <span className="inline-flex items-center justify-end gap-2">
                        {/*
                          Compare against the live version by default — "what
                          would change if I published this" is the question a
                          row's Compare is being asked. For the live row itself
                          there is nothing to compare it to, so it compares
                          against the newest instead.
                        */}
                        <Link
                          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                          href={compareHref(id, row.version, publishedVersion, newest)}
                        >
                          Compare
                        </Link>
                        {row.canPublish ? (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={publish.isPending}
                            onClick={() => confirmPublish(row)}
                          >
                            Publish
                          </Button>
                        ) : row.canRetry ? (
                          <Button size="sm" variant="secondary" disabled>
                            Retry
                          </Button>
                        ) : (
                          <span className="text-xs text-subtle-foreground">
                            {row.publishBlockedReason ?? ''}
                          </span>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/*
        §8's confirmation. A `Modal` rather than a confirm-in-place, and never
        `window.confirm` — which is guarded against, unstyleable, and announced
        by a different path from everything else in the app.
      */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === null ? 'Publish' : `Publish v${confirming.version}?`}
      >
        {confirming === null ? null : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {publishedVersion === null ? (
                <>This will bring the hosted API up on v{confirming.version}.</>
              ) : (
                <>
                  Publishing v{confirming.version} replaces v{publishedVersion} as the live API
                  version. v{publishedVersion} is kept and stays comparable.
                </>
              )}
            </p>

            {confirming.status === 'DEGRADED' ? (
              <Note variant="warning">
                Some optional artifacts did not generate. The API will serve, but the downloads for
                this version will be missing or out of date.
              </Note>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={publish.isPending}
                onClick={() => runPublish(confirming.version)}
              >
                {publish.isPending ? 'Publishing…' : 'Publish version'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

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
import { useParams, useRouter } from 'next/navigation';
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
  useRestoreVersion,
  useVersionComparison,
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

/**
 * §23's rollback confirmation.
 *
 * A `Modal`, never `window.confirm` — which is guarded against, unstyleable,
 * and announced by a different path from everything else in the app.
 *
 * ## Why it previews the diff
 *
 * "Are you sure?" is not a confirmation, it is a speed bump. The comparison
 * endpoint already computes exactly this pair — the current definition against
 * the one being restored — so the dialog can name what would break instead of
 * asking the user to take the word "rollback" on trust. §23 requires the
 * confirmation *because* a rollback can be breaking, so the dialog says whether
 * this one is.
 *
 * Its own component so the comparison query mounts with the dialog: fetching a
 * preview for a button nobody pressed would be a request per row.
 */
function RollbackDialog({
  projectId,
  row,
  currentVersion,
  busy,
  onCancel,
  onConfirm,
}: {
  projectId: string;
  row: VersionRowView;
  currentVersion: number | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const comparison = useVersionComparison(projectId, currentVersion, row.version);
  const summary = comparison.data?.summary ?? null;
  const breaking = summary?.impact.BREAKING ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        This opens a draft holding v{row.version}&rsquo;s definition for review. Nothing changes for
        callers now — the rollback becomes a new version when you commit it, and goes live only when
        you publish that version.
      </p>

      {comparison.isPending ? (
        <div className="h-10 animate-pulse rounded-md bg-muted" />
      ) : summary === null ? (
        // A failed preview must not block the rollback: the review screen
        // computes the same diff and is the gate that actually matters.
        <span className="text-xs text-subtle-foreground">
          Could not load a preview of the change. The review screen will show it in full.
        </span>
      ) : summary.total === 0 ? (
        <Note>
          v{row.version} matches the current definition, so this rollback would change nothing.
        </Note>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-sm">
            {summary.total} {summary.total === 1 ? 'change' : 'changes'} ·{' '}
            {summary.affectedEndpoints}{' '}
            {summary.affectedEndpoints === 1 ? 'API affected' : 'APIs affected'}
          </span>
          {breaking > 0 ? (
            <Note variant="warning">
              {breaking} of {summary.total === 1 ? 'this change' : 'these changes'}{' '}
              {breaking === 1 ? 'is' : 'are'} breaking: callers that work against v{currentVersion}{' '}
              will fail once this is published. You will be asked to acknowledge each one before the
              commit goes through.
            </Note>
          ) : null}
          <Link
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            href={`/projects/${projectId}/versions/compare?from=${currentVersion ?? row.version}&to=${row.version}`}
          >
            See the full comparison
          </Link>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy
            ? 'Loading…'
            : breaking > 0
              ? 'Review this rollback anyway'
              : 'Review this rollback'}
        </Button>
      </div>
    </div>
  );
}

export default function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const versions = useVersions(id);

  /** The version awaiting confirmation, or null when no dialog is open. */
  const [confirming, setConfirming] = useState<VersionRowView | null>(null);
  /** The version awaiting §23's rollback confirmation. */
  const [reverting, setReverting] = useState<VersionRowView | null>(null);

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

  /**
   * §22: a rollback seeds a draft, so this resolves to a review screen rather
   * than to a changed project.
   *
   * No `success` message: "Rollback created as version v6" would be a lie about
   * something that has not happened yet, and the panel the user lands on says
   * what it is in its own heading. Failures keep the default toast — this
   * action navigates away, so there is no form left to show an inline error.
   */
  const restore = useAction(useRestoreVersion(id), {
    loading: 'Loading that version for review…',
    onFailure: () => setReverting(null),
  });

  const publishedVersion = project.data?.publishedVersion ?? null;
  const currentVersion = project.data?.currentVersion ?? null;
  const rows = useMemo(
    () =>
      (versions.data?.data ?? []).map((version) =>
        toVersionRow(version, publishedVersion, currentVersion),
      ),
    [versions.data, publishedVersion, currentVersion],
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

  const runRollback = (version: number): void => {
    void restore.run(version).then((draft) => {
      // `null` is a failure `useAction` has already toasted, and `onFailure`
      // closed the dialog. Only navigate on the draft actually arriving.
      if (draft !== null) {
        setReverting(null);
        router.push(`/projects/${id}/edit?stage=review`);
      }
    });
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
                        {row.canRollBack ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={restore.isPending}
                            onClick={() => setReverting(row)}
                          >
                            Roll back
                          </Button>
                        ) : null}
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

      {/* §23. Separate from the publish dialog: they confirm opposite things,
          and one dialog that changed its meaning based on which button opened
          it is how a user confirms the wrong action. */}
      <Modal
        open={reverting !== null}
        onClose={() => setReverting(null)}
        title={reverting === null ? 'Roll back' : `Roll back to v${reverting.version}?`}
      >
        {reverting === null ? null : (
          <RollbackDialog
            projectId={id}
            row={reverting}
            currentVersion={currentVersion}
            busy={restore.isPending}
            onCancel={() => setReverting(null)}
            onConfirm={() => runRollback(reverting.version)}
          />
        )}
      </Modal>
    </div>
  );
}

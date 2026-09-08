'use client';

/**
 * The Auth tab (Phase 3 §1–§3, §15, §21, §25).
 *
 * ## It edits the draft, like every other definition change
 *
 * §17 requires authentication changes to be versioned and diffed, so there is
 * no dedicated endpoint: the mode, the per-entity settings and the token
 * lifetimes all live at the IPS root and go out as a `PATCH /draft`. Saving
 * therefore leaves the user with an uncommitted draft, and the honest next step
 * is the review screen — not a "saved" toast implying the live API changed.
 *
 * ## The tab shows the draft; the tester calls the published API
 *
 * Those are different versions, and the gap is the single most confusing thing
 * about this screen. It is stated in the panel rather than hidden, and
 * `describeProbe` explains a contradiction when one appears instead of leaving
 * the user to conclude the product is broken.
 *
 * ## Colour
 *
 * Per §25 and the theme's rule that vividness scales inversely with area: a
 * status dot with a neutral label, no filled rows. A table of protected
 * entities would otherwise be a column of red words.
 */

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  FieldError,
  FormError,
  Icon,
  Input,
  Note,
  Select,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  tableNumeric,
} from '@instantmockapi/ui';
import { useDraft, useProject, useSaveDraft } from '../../../../lib/hooks';
import { useAction } from '../../../../lib/use-action';
import { notifyFailure, notifySuccess } from '../../../../lib/toast';
import { normalizeError } from '../../../../lib/errors';
import type { IpsAuthShape } from '../../../../lib/api-types';
import {
  AUTH_MODES,
  MODE_DESCRIPTION,
  MODE_LABEL,
  applyMode,
  authConfigOf,
  authEnabled,
  authProblems,
  authSummary,
  entityAuthRows,
  setEntityAuth,
  updateAuthSettings,
} from '../../../../lib/auth-config';
import {
  STATUS_LABEL,
  STATUS_TONE,
  copyableToken,
  describeProbe,
  tokenDisplay,
  probeContradictsConfig,
  testerActions,
  testerStatus,
  type ProbeResult,
  type TesterSession,
} from '../../../../lib/auth-tester';

export default function AuthPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const draft = useDraft(id);

  /**
   * The edited definition, held locally until saved.
   *
   * Seeded from the draft on first load and then owned here, because every
   * control on this page is a small edit to one document — round-tripping each
   * one through the server would make the mode selector wait on a request.
   */
  const [edited, setEdited] = useState<IpsAuthShape | null>(null);
  const ips = edited ?? (draft.data?.ips as IpsAuthShape | undefined) ?? null;

  const save = useAction(useSaveDraft(id), { toast: false, formError: true });

  const config = useMemo(() => authConfigOf(ips), [ips]);
  const rows = useMemo(() => entityAuthRows(ips), [ips]);
  const problems = useMemo(() => authProblems(ips), [ips]);
  const enabled = authEnabled(config);
  // An Auth API project has no entities, so the whole-project mode is not a
  // question it can answer — see the Note below.
  const isAuthKind = project.data?.kind === 'auth';

  const edit = (next: IpsAuthShape): void => setEdited(next);

  const commit = async (): Promise<void> => {
    if (ips === null || problems.length > 0) {
      return;
    }
    const saved = await save.run({ ips: ips as unknown as Record<string, unknown> });
    if (saved !== null) {
      // The draft is saved but nothing is live yet, so the review screen is the
      // truthful destination — §17's change has to be committed and published
      // like any other.
      router.push(`/projects/${id}/edit?stage=review`);
    }
  };

  if (draft.isError) {
    return (
      <ErrorState
        title="Could not open the editor"
        detail={normalizeError(draft.error).title}
        onRetry={() => void draft.refetch()}
      />
    );
  }

  if (ips === null) {
    return <div className="h-40 animate-pulse rounded-md bg-muted" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Authentication</h2>
            <span className="text-xs text-muted-foreground">{authSummary(ips)}</span>
          </div>
          {enabled ? (
            <StatusChip status="ready" label="Auth API generated" />
          ) : (
            <StatusChip status="draft" label="Off" />
          )}
        </div>

        {/* §17: this is a versioned schema change, and saying so up front is
            what stops a user expecting the live API to move when they save. */}
        <Note>
          Changing authentication changes the definition. It is reviewed, committed and published
          like any other schema change — the live API keeps serving v
          {project.data?.publishedVersion ?? '—'} until you publish the version this produces.
        </Note>

        {/*
          The mode is not a question an Auth API project can answer.

          All four options describe which *entities* require a token, and this
          kind has none — so "All protected" and "Per entity" would be choices
          with no effect, over an entity list that is empty. The screen instead
          goes straight to what this project actually has: its endpoints and its
          sign-up fields, which is what the wizard asked.
        */}
        {isAuthKind ? (
          <Note>
            This project is the login flow on its own, so there are no entities to protect. Add an
            entity from <span className="ui-mono">Edit data model</span> and the access options
            appear here.
          </Note>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Mode</legend>
            {AUTH_MODES.map((mode) => (
              <label key={mode} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="auth-mode"
                  className="mt-1"
                  checked={config.mode === mode}
                  onChange={() => edit(applyMode(ips, mode))}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">{MODE_LABEL[mode]}</span>
                  <span className="text-xs text-muted-foreground">{MODE_DESCRIPTION[mode]}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </Card>

      {/* §3's entity list. Rendered in every mode, not just COMBINATION: the
          question "which of my endpoints need a token" deserves an answer
          whatever the mode, and hiding the table would make ALL_PROTECTED look
          like it had no effect. */}
      {rows.length > 0 && (
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Entities</h2>
            <span className="text-xs text-muted-foreground">
              {config.mode === 'COMBINATION'
                ? 'Choose per entity. All methods of an entity share its setting — GET, POST, PUT, PATCH and DELETE together.'
                : `The mode decides for every entity. Choose ${MODE_LABEL.COMBINATION} to set them individually.`}
            </span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Access</TableHead>
                <TableHead className={tableNumeric}>Requires token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.name}>
                  <TableRowHeader>{row.name}</TableRowHeader>
                  <TableCell>
                    {/* A dot and a neutral word, never a coloured label — a
                        twelve-entity table would otherwise be a column of red. */}
                    <StatusChip
                      status={row.auth === 'PROTECTED' ? 'live' : 'draft'}
                      label={row.auth === 'PROTECTED' ? 'Protected' : 'Public'}
                    />
                  </TableCell>
                  <TableCell className={tableNumeric}>
                    <Checkbox
                      checked={row.auth === 'PROTECTED'}
                      disabled={!row.editable}
                      onChange={() =>
                        edit(
                          setEntityAuth(
                            ips,
                            row.name,
                            row.auth === 'PROTECTED' ? 'PUBLIC' : 'PROTECTED',
                          ),
                        )
                      }
                      label=""
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {enabled && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Auth API</h2>

          <div className="flex flex-col gap-2">
            <Checkbox
              checked={config.signup}
              onChange={() => edit(updateAuthSettings(ips, { signup: !config.signup }))}
              label="Generate POST /signUp"
            />
            <span className="pl-6 text-xs text-subtle-foreground">
              Turn off for an invite-only API: accounts exist, but not through a public endpoint.
            </span>

            <Checkbox
              checked={config.refreshToken}
              onChange={() => edit(updateAuthSettings(ips, { refreshToken: !config.refreshToken }))}
              label="Generate POST /refresh"
            />

            <Checkbox
              checked={config.cookieAuth}
              onChange={() => edit(updateAuthSettings(ips, { cookieAuth: !config.cookieAuth }))}
              label="Use HttpOnly cookies"
            />
            <span className="pl-6 text-xs text-subtle-foreground">
              Tokens are set as cookies and omitted from the sign-in response, so browser code
              cannot read them. Non-browser callers keep using the Authorization header.
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Access token lifetime" hint="Short by design — refreshing is cheap.">
              <Input
                value={config.accessTokenExpiresIn}
                onChange={(event) =>
                  edit(updateAuthSettings(ips, { accessTokenExpiresIn: event.target.value }))
                }
              />
              <ProblemFor problems={problems} field="accessTokenExpiresIn" />
            </Field>
            <Field label="Refresh token lifetime">
              <Input
                value={config.refreshTokenExpiresIn}
                onChange={(event) =>
                  edit(updateAuthSettings(ips, { refreshTokenExpiresIn: event.target.value }))
                }
                disabled={!config.refreshToken}
              />
              <ProblemFor problems={problems} field="refreshTokenExpiresIn" />
            </Field>
          </div>

          <ProblemFor problems={problems} field="signin" />

          <UserFields ips={ips} onChange={edit} problems={problems} />
        </Card>
      )}

      {problems
        .filter((problem) => problem.field === 'entities')
        .map((problem) => (
          <Alert key={problem.message} variant="warning">
            <AlertTitle>An entity name collides with the Auth API</AlertTitle>
            <AlertDescription>{problem.message}</AlertDescription>
          </Alert>
        ))}

      <Card className="flex flex-row items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {problems.length > 0
            ? 'Fix the problems above before saving.'
            : 'Saving opens the review screen, where you commit and regenerate.'}
        </span>
        <Button
          variant="primary"
          disabled={save.isPending || problems.length > 0}
          onClick={() => void commit()}
        >
          {save.isPending ? 'Saving…' : 'Save and review'}
        </Button>
      </Card>

      {/* `FormError`, not `FieldError`: a rejected save belongs to the whole
          form, and there is no single control it sits beside. The field-level
          messages above are the other case — each one names one input. */}
      {save.formError !== null && <FormError title={save.formError.title} />}

      <AuthTester
        projectId={id}
        hostedUrl={project.data?.hosted.url ?? null}
        cookieAuth={config.cookieAuth}
        signup={config.signup}
        refreshEnabled={config.refreshToken}
        rows={rows}
      />
    </div>
  );
}

function ProblemFor({
  problems,
  field,
}: {
  problems: { field: string; message: string }[];
  field: string;
}) {
  const problem = problems.find((entry) => entry.field === field);
  return problem === undefined ? null : <FieldError>{problem.message}</FieldError>;
}

/** §5's custom signup fields. */
function UserFields({
  ips,
  onChange,
  problems,
}: {
  ips: IpsAuthShape;
  onChange: (next: IpsAuthShape) => void;
  problems: { field: string; message: string }[];
}) {
  const config = authConfigOf(ips);

  const update = (index: number, patch: Partial<(typeof config.userFields)[number]>): void => {
    onChange(
      updateAuthSettings(ips, {
        userFields: config.userFields.map((field, position) =>
          position === index ? { ...field, ...patch } : field,
        ),
      }),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Signup fields</h3>
        <span className="text-xs text-muted-foreground">
          Collected alongside email and password. Email, password and the timestamps already exist
          and cannot be redeclared.
        </span>
      </div>

      {config.userFields.map((field, index) => (
        <div key={index} className="flex flex-wrap items-start gap-2">
          <div className="flex flex-col gap-1">
            <Input
              value={field.name}
              placeholder="displayName"
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <ProblemFor problems={problems} field={`userFields.${index}.name`} />
          </div>
          <Select
            value={field.type}
            onChange={(event) =>
              update(index, { type: event.target.value as 'string' | 'number' | 'boolean' })
            }
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </Select>
          <Checkbox
            checked={field.required}
            onChange={() => update(index, { required: !field.required })}
            label="Required"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange(
                updateAuthSettings(ips, {
                  userFields: config.userFields.filter((_, position) => position !== index),
                }),
              )
            }
          >
            <Icon name="trash" size={14} label={`Remove ${field.name || 'field'}`} />
          </Button>
        </div>
      ))}

      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          onChange(
            updateAuthSettings(ips, {
              userFields: [...config.userFields, { name: '', type: 'string', required: false }],
            }),
          )
        }
      >
        <Icon name="plus" size={14} /> Add field
      </Button>
    </div>
  );
}

/**
 * One credential: masked, revealable, copyable.
 *
 * Copy does not require reveal, which is the common case — paste into curl
 * without the token ever being on screen. `copyableToken` supplies the real
 * value regardless of what is rendered, so this cannot copy the mask.
 */
function Credential({
  label,
  token,
  revealed,
  onReveal,
}: {
  label: string;
  token: string | null;
  revealed: boolean;
  onReveal: () => void;
}) {
  const value = copyableToken(token);

  const copy = (): void => {
    if (value === null) {
      return;
    }
    // A toast either way: a copy that silently did nothing is the worst
    // outcome, because the user pastes whatever was on the clipboard before.
    navigator.clipboard.writeText(value).then(
      () => notifySuccess(`${label} copied`),
      (cause: unknown) =>
        notifyFailure({
          ...normalizeError(cause),
          title: `Could not copy the ${label.toLowerCase()}`,
          detail: 'Your browser blocked clipboard access. Reveal it and copy by hand.',
        }),
    );
  };

  return (
    <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <span>{label}:</span>
      {/* `break-all` so a revealed JWT wraps instead of stretching the card. */}
      <span className="ui-mono break-all">{tokenDisplay(token, revealed)}</span>
      {value === null ? null : (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReveal}
            aria-pressed={revealed}
            aria-label={
              revealed ? `Hide the ${label.toLowerCase()}` : `Show the ${label.toLowerCase()}`
            }
          >
            <Icon name="eye" size={14} /> {revealed ? 'Hide' : 'Show'}
          </Button>
          <Button variant="ghost" size="sm" onClick={copy}>
            <Icon name="copy" size={14} /> Copy
          </Button>
        </>
      )}
    </span>
  );
}

/**
 * §21's tester, against the **live** hosted API.
 *
 * Calls the hosted URL directly rather than proxying through the platform API:
 * the point is to exercise the thing a real caller would hit, including its
 * CORS and cookie behaviour. A proxy would test the proxy.
 */
function AuthTester({
  projectId,
  hostedUrl,
  cookieAuth,
  signup,
  refreshEnabled,
  rows,
}: {
  projectId: string;
  hostedUrl: string | null;
  cookieAuth: boolean;
  signup: boolean;
  refreshEnabled: boolean;
  rows: { name: string; auth: 'PUBLIC' | 'PROTECTED' }[];
}) {
  const [email, setEmail] = useState('end-user@example.com');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<TesterSession | null>(null);
  /**
   * Which credentials are currently on screen.
   *
   * Reset whenever the session is replaced — signing in again must not inherit
   * "revealed" from the previous session, or a fresh token appears on screen
   * without anyone asking for it.
   */
  const [revealed, setRevealed] = useState({ access: false, refresh: false });
  const [probe, setProbe] = useState<{
    result: ProbeResult;
    expected: 'PUBLIC' | 'PROTECTED';
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const status = testerStatus(session, cookieAuth);
  const actions = testerActions({
    status,
    signup,
    refreshToken: refreshEnabled,
    hasRefreshToken: session?.refreshToken !== null && session?.refreshToken !== undefined,
    cookieAuth,
  });

  if (hostedUrl === null) {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Test authentication</h2>
        <span className="text-xs text-muted-foreground">
          Nothing is published yet. Generate this project and publish a version, then the flow can
          be exercised here against the live API.
        </span>
      </Card>
    );
  }

  const call = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${hostedUrl}/${path}`, {
      ...init,
      // Cookie mode needs credentialed requests, and the runtime's CORS is
      // configured for it. Sending them unconditionally would be wrong: with
      // `origin: true` and credentials the browser rejects the response.
      ...(cookieAuth ? { credentials: 'include' as const } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(session?.accessToken !== null && session?.accessToken !== undefined
          ? { Authorization: `Bearer ${session.accessToken}` }
          : {}),
        ...(init.headers ?? {}),
      },
    });
    const body =
      response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
    return { status: response.status, body };
  };

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await task();
    } catch (cause) {
      const failure = normalizeError(cause);
      notifyFailure({ ...failure, title: 'The hosted API could not be reached' });
    } finally {
      setBusy(false);
    }
  };

  const adopt = (body: Record<string, unknown>): void => {
    // A new session is a new pair of tokens, so nothing carries over from the
    // last one being on screen.
    setRevealed({ access: false, refresh: false });
    setSession({
      email,
      accessToken: (body['accessToken'] as string | undefined) ?? null,
      refreshToken: (body['refreshToken'] as string | undefined) ?? null,
      user: (body['user'] as Record<string, unknown> | undefined) ?? null,
    });
  };

  const credentials = () => ({ method: 'POST', body: JSON.stringify({ email, password }) });

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Test authentication</h2>
          <span className="text-xs text-muted-foreground">
            Runs against the published API, not the draft above. A result that contradicts your
            settings usually means this version has not been generated and published yet.
          </span>
        </div>
        <StatusChip status={STATUS_TONE[status]} label={STATUS_LABEL[status]} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <Input value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        {actions.signUp && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { body } = await call('signUp', credentials());
                adopt(body);
              })
            }
          >
            Sign up
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { body } = await call('signIn', credentials());
              adopt(body);
            })
          }
        >
          Sign in
        </Button>
        {actions.refresh && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { body } = await call('refresh', {
                  method: 'POST',
                  body: JSON.stringify({ refreshToken: session?.refreshToken }),
                });
                adopt(body);
              })
            }
          >
            Refresh
          </Button>
        )}
        {actions.me && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { body } = await call('me');
                setSession((current) =>
                  current === null
                    ? current
                    : { ...current, user: (body['user'] as Record<string, unknown>) ?? null },
                );
              })
            }
          >
            Get /me
          </Button>
        )}
        {actions.logout && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await call('logout', {
                  method: 'POST',
                  body: JSON.stringify({ refreshToken: session?.refreshToken }),
                });
                setRevealed({ access: false, refresh: false });
                setSession(null);
              })
            }
          >
            Log out
          </Button>
        )}
      </div>

      {session !== null && (
        <div className="flex flex-col gap-2 text-xs">
          <span className="text-muted-foreground">
            User: <span className="ui-mono">{session.email}</span>
          </span>
          {/* Masked by default, one click from visible, and copyable without
              being visible. These are the user's own credentials for their own
              mock API — but a token printed as text ends up in every screenshot
              and screen share of this page, so it is never on screen by
              accident. */}
          <Credential
            label="Access token"
            token={session.accessToken}
            revealed={revealed.access}
            onReveal={() => setRevealed((current) => ({ ...current, access: !current.access }))}
          />
          <Credential
            label="Refresh token"
            token={session.refreshToken}
            revealed={revealed.refresh}
            onReveal={() => setRevealed((current) => ({ ...current, refresh: !current.refresh }))}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Call an endpoint</h3>
          <div className="flex flex-wrap gap-2">
            {rows.map((row) => (
              <Button
                key={row.name}
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = row.name.toLowerCase();
                    const { status: code } = await call(path);
                    setProbe({ result: { status: code, path }, expected: row.auth });
                  })
                }
              >
                GET /{row.name.toLowerCase()}
                <Badge variant="neutral">{row.auth === 'PROTECTED' ? 'Protected' : 'Public'}</Badge>
              </Button>
            ))}
          </div>

          {probe !== null &&
            (probeContradictsConfig(probe.result, probe.expected, status !== 'signed-out') ? (
              <Alert variant="warning">
                <AlertTitle>This does not match your settings</AlertTitle>
                <AlertDescription>{describeProbe(probe.result, probe.expected)}</AlertDescription>
              </Alert>
            ) : (
              <Note>{describeProbe(probe.result, probe.expected)}</Note>
            ))}
        </div>
      )}

      <span className="text-xs text-subtle-foreground ui-mono">{hostedUrl}</span>
      <input type="hidden" value={projectId} />
    </Card>
  );
}

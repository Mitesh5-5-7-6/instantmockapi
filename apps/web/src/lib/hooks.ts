'use client';

/**
 * TanStack Query hooks over the platform API — the client data layer
 * (doc 08, Phase 6). Screens consume these; no component fetches directly.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adoptSession,
  apiFetch,
  forgetSession,
  getAuthState,
  getServerAuthState,
  restoreSession,
  subscribeAuth,
  subscribeJobStream,
  type AuthState,
} from './api-client';
import type {
  ApiUser,
  ArtifactContent,
  ArtifactListMeta,
  ArtifactView,
  DashboardView,
  DraftAnalysis,
  DraftCommitResult,
  AuthAcknowledgement,
  AuthSession,
  GenerationConfig,
  JobView,
  ListEnvelope,
  ProjectDetail,
  ProjectDraft,
  ProjectListRow,
  ProjectLogsEnvelope,
  ProjectLogsParams,
  ProjectMetricsView,
  RestoredDraft,
  VersionChangeSummary,
  VersionChangeType,
  VersionComparison,
  VersionStatus,
} from './api-types';

/**
 * Everything a screen needs after a session is established.
 *
 * The response already carries the user, so `['me']` is seeded rather than
 * refetched — the shell would otherwise wait on a `/v1/me` round trip before it
 * could render anything. Everything else was fetched (or skipped) while
 * unauthenticated, so it is all stale now.
 */
function useSessionEstablished() {
  const queryClient = useQueryClient();
  return (session: AuthSession) => {
    adoptSession(session);
    queryClient.setQueryData(['me'], { user: session.user });
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
  };
}

/**
 * Sign in with an email and password.
 *
 * Resolves to a discriminated result rather than throwing for the
 * password-not-set case, because that case is not a failure: the account exists,
 * nothing was wrong with the request, and an email has been sent (doc 13 D3). A
 * wrong password still throws `ApiError`.
 */
export function useLogin() {
  const onSession = useSessionEstablished();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const result = await apiFetch<AuthSession | AuthAcknowledgement>('/v1/auth/login', {
        method: 'POST',
        body: input,
        // The response sets the refresh cookie, which the browser only stores on
        // a credentialed request.
        withCredentials: true,
      });
      if ('accessToken' in result) {
        onSession(result);
        return { kind: 'signed-in' as const, user: result.user };
      }
      return { kind: 'password-setup-required' as const, message: result.message };
    },
  });
}

/** Create an account. Returns the acknowledgement; there is no session yet. */
export function useSignup() {
  return useMutation({
    mutationFn: (input: { email: string; password: string; name?: string }) =>
      apiFetch<AuthAcknowledgement>('/v1/auth/signup', { method: 'POST', body: input }),
  });
}

/** Redeem an emailed verification link. Signs the user in on success. */
export function useVerifyEmail() {
  const onSession = useSessionEstablished();
  return useMutation({
    mutationFn: async (token: string) => {
      const session = await apiFetch<AuthSession>('/v1/auth/verify-email', {
        method: 'POST',
        body: { token },
        withCredentials: true,
      });
      onSession(session);
      return session.user;
    },
  });
}

/**
 * Ask for a password-reset link.
 *
 * The API answers identically whether or not the address exists, so there is
 * nothing here to branch on — and the screen must not invent a distinction.
 */
export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) =>
      apiFetch<AuthAcknowledgement>('/v1/auth/forgot-password', {
        method: 'POST',
        body: { email },
      }),
  });
}

/** Same neutrality as forgot-password: one response for every case. */
export function useResendVerification() {
  return useMutation({
    mutationFn: (email: string) =>
      apiFetch<AuthAcknowledgement>('/v1/auth/resend-verification', {
        method: 'POST',
        body: { email },
      }),
  });
}

/** Redeem a reset or set-password link. Signs the user in on success. */
export function useResetPassword() {
  const onSession = useSessionEstablished();
  return useMutation({
    mutationFn: async (input: { token: string; password: string }) => {
      const session = await apiFetch<AuthSession>('/v1/auth/reset-password', {
        method: 'POST',
        body: input,
        withCredentials: true,
      });
      onSession(session);
      return session.user;
    },
  });
}

/**
 * Change the password of the signed-in user.
 *
 * The API bumps `tokenVersion`, which kills every other session including this
 * browser's refresh cookie — so the response carries a replacement session that
 * has to be adopted, or the caller is signed out within the access token's
 * lifetime.
 */
export function useChangePassword() {
  const onSession = useSessionEstablished();
  return useMutation({
    mutationFn: async (input: { currentPassword: string; newPassword: string }) => {
      const session = await apiFetch<AuthSession>('/v1/auth/change-password', {
        method: 'POST',
        body: input,
        withCredentials: true,
      });
      onSession(session);
      return session.user;
    },
  });
}

/**
 * Exchange a Google authorization code for a session.
 *
 * The code and the PKCE verifier go to our API, never to Google from here — the
 * client secret the exchange needs stays on the server, which is the whole
 * reason the authorization-code flow is used instead of an implicit one.
 */
export function useGoogleSignIn() {
  const onSession = useSessionEstablished();
  return useMutation({
    mutationFn: async (input: { code: string; codeVerifier: string; redirectUri: string }) => {
      const session = await apiFetch<AuthSession>('/v1/auth/google', {
        method: 'POST',
        body: input,
        withCredentials: true,
      });
      onSession(session);
      return session.user;
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        // withCredentials so the API can clear the cookie it set — a response
        // without credentials cannot expire one.
        await apiFetch('/v1/auth/logout', { method: 'POST', withCredentials: true });
      } finally {
        // In the `finally` on purpose: if the request fails, the local session
        // still has to go. Leaving the user apparently signed in after they
        // pressed sign out is the worse outcome.
        forgetSession();
      }
    },
    onSuccess: () => queryClient.clear(),
    onError: () => queryClient.clear(),
  });
}

export type { AuthState };

/**
 * Auth state as reactive state, so signing in and out re-render their consumers.
 *
 * `unknown` is both the server/hydration snapshot *and* the real state until the
 * boot refresh returns — with the access token in memory only, "am I signed in"
 * cannot be answered synchronously any more. `useRestoreSession` below is what
 * moves it off `unknown`.
 */
export function useAuthState(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, getServerAuthState);
}

/**
 * Ask the API for a session once, on mount.
 *
 * This is the step that replaces reading `localStorage`: the refresh cookie is
 * the only thing that survived the page load, and it is httpOnly, so the only
 * way to learn whether it is still valid is to spend a request. Mounted once, by
 * the shell, above everything that fetches.
 */
export function useRestoreSession(): AuthState {
  const state = useAuthState();
  useEffect(() => {
    void restoreSession();
  }, []);
  return state;
}

export function useMe() {
  const authState = useAuthState();
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<{ user: ApiUser }>('/v1/me'),
    enabled: authState === 'authenticated',
    retry: false,
    select: (data) => data.user,
  });
}

export interface ProjectListParams {
  page?: number;
  limit?: number;
  status?: string;
  sort?: string;
  q?: string;
}

/**
 * Update the current user.
 *
 * Writes the response straight into the [me] cache rather than invalidating —
 * the PATCH already returns the updated user, so a refetch would be a second
 * round trip for data already in hand.
 */
export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string | null }) =>
      apiFetch<{ user: ApiUser }>('/v1/me', { method: 'PATCH', body: input }),
    onSuccess: (data) => queryClient.setQueryData(['me'], data),
  });
}

/** Windows the dashboard endpoint accepts; anything else is a 400 by design. */
export type DashboardDays = 7 | 14 | 30;

/**
 * The whole landing screen in one request.
 *
 * One call rather than several because the figures have to agree: the tile total
 * and the sum of the chart are computed from the same matched set server-side,
 * and two separate fetches could straddle a bucket boundary and disagree.
 */
export function useDashboard(days: DashboardDays = 7) {
  return useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => apiFetch<DashboardView>(`/v1/dashboard?days=${days}`),
  });
}

export function useProjects(params: ProjectListParams = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return useQuery({
    queryKey: ['projects', params],
    // `ProjectListRow`, not `ProjectSummary`: the endpoint already returns
    // endpoint and request counts per row, and typing them as the narrower shape
    // is what kept them off the screen.
    queryFn: () => apiFetch<ListEnvelope<ProjectListRow>>(`/v1/projects${qs ? `?${qs}` : ''}`),
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<ProjectDetail>(`/v1/projects/${projectId}`),
    enabled: projectId !== null,
  });
}

/** Windows the metrics endpoint accepts; anything else is a 400 by design. */
export type MetricsDays = 7 | 14 | 30;

/**
 * One project's traffic, in a single request.
 *
 * One call rather than several because the figures have to agree: the tiles, the
 * chart and the endpoint breakdown are computed from the same matched set
 * server-side, and separate fetches could straddle a bucket boundary and
 * disagree — which a reader can only read as a bug.
 */
export function useProjectMetrics(projectId: string, days: MetricsDays = 7, activityLimit = 8) {
  return useQuery({
    queryKey: ['project-metrics', projectId, days, activityLimit],
    queryFn: () =>
      apiFetch<ProjectMetricsView>(
        `/v1/projects/${projectId}/metrics?days=${days}&activityLimit=${activityLimit}`,
      ),
  });
}

/**
 * A page of the request log.
 *
 * `refetchInterval` is the caller’s choice, not a default: the Logs tab polls
 * while unfiltered and stops once a filter is applied, because a list that
 * reshuffles under you while you are reading it is worse than a stale one.
 */
export function useProjectLogs(
  projectId: string,
  params: ProjectLogsParams = {},
  options: { refetchInterval?: number | false } = {},
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // Empty strings are dropped rather than sent: `?q=` would be a prefix
    // filter matching everything, which is the same as no filter but costs a
    // regex on every row.
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();

  return useQuery({
    queryKey: ['project-logs', projectId, query],
    queryFn: () =>
      apiFetch<ProjectLogsEnvelope>(`/v1/projects/${projectId}/logs${query ? `?${query}` : ''}`),
    refetchInterval: options.refetchInterval ?? false,
    // Keeps the previous page visible while the next one loads, so paging does
    // not blank the table on every click.
    placeholderData: (previous) => previous,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      kind?: 'project' | 'single' | 'auth';
      slug?: string;
      description?: string;
      inputSource: { type: string; raw: unknown };
    }) => apiFetch<ProjectDetail>('/v1/projects', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useGenerate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (generationConfig?: GenerationConfig) =>
      apiFetch<{ jobId: string; status: string }>(`/v1/projects/${projectId}/generate`, {
        method: 'POST',
        body: generationConfig ? { generationConfig } : {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['job', jobId],
    queryFn: () => apiFetch<JobView>(`/v1/jobs/${jobId}`),
    enabled: jobId !== null,
    // The SSE stream (useJobStream) gives instant updates, but the API caps
    // each connection at ~25s. Poll as a safety net so a job that runs longer
    // never appears frozen; stop once it settles (completed / failed_partial).
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2_000 : false;
    },
  });
}

/**
 * Live job progress: subscribes to the SSE stream and mirrors snapshots into
 * the query cache, so `useJob` consumers re-render on every transition
 * (doc 10 §8). Falls back silently — the base query still resolves state.
 */
export function useJobStream(jobId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!jobId) {
      return;
    }
    let cancelled = false;
    let abort: (() => void) | null = null;
    const connect = (): void => {
      if (cancelled) {
        return;
      }
      abort = subscribeJobStream(
        jobId,
        (snapshot) => queryClient.setQueryData(['job', jobId], snapshot),
        () => {
          // The API caps each SSE connection at ~25s. Reconnect while the job
          // is still unsettled so progress keeps flowing in real time; stop
          // once it reaches a terminal state.
          const status = queryClient.getQueryData<JobView>(['job', jobId])?.status;
          if (!cancelled && (status === 'queued' || status === 'running')) {
            setTimeout(connect, 500);
          }
        },
      );
    };
    connect();
    return () => {
      cancelled = true;
      abort?.();
    };
  }, [jobId, queryClient]);
}

export function useArtifacts(projectId: string | null, version?: number) {
  const qs = version !== undefined ? `?version=${version}` : '';
  return useQuery({
    queryKey: ['artifacts', projectId, version ?? 'current'],
    queryFn: () =>
      apiFetch<{ data: ArtifactView[]; meta: ArtifactListMeta }>(
        `/v1/projects/${projectId}/artifacts${qs}`,
      ),
    enabled: projectId !== null,
  });
}

/** Lazily fetch an artifact's decoded content for the code viewer. Stays idle
 * until an artifactType is set (the viewer opens). */
export function useArtifactContent(
  projectId: string | null,
  artifactType: string | null,
  version?: number,
) {
  const qs = version !== undefined ? `?version=${version}` : '';
  return useQuery({
    queryKey: ['artifact-content', projectId, artifactType, version ?? 'current'],
    queryFn: () =>
      apiFetch<ArtifactContent>(`/v1/projects/${projectId}/artifacts/${artifactType}/content${qs}`),
    enabled: projectId !== null && artifactType !== null,
  });
}

export function useRegenerate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (artifacts: string[]) =>
      apiFetch<{ jobId: string; status: string }>(`/v1/projects/${projectId}/regenerate`, {
        method: 'POST',
        body: { artifacts },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['artifacts', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

export function useGenerateAgain(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ jobId: string; status: string }>(`/v1/projects/${projectId}/generate-again`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useRetryWorker(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (worker: string) =>
      apiFetch<{ jobId: string; status: string }>(`/v1/jobs/${jobId}/workers/${worker}/retry`, {
        method: 'POST',
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
  });
}

/**
 * Update a project's settings.
 *
 * Writes the response into the `['project', id]` cache rather than
 * invalidating: the PATCH already returns the full detail, so a refetch would
 * be a second round trip for data already in hand — and the header, which reads
 * the same key, updates in the same tick.
 *
 * `['projects']` IS invalidated, because a rename changes the list.
 */
export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      slug?: string;
      description?: string;
      generationConfig?: GenerationConfig;
    }) => apiFetch<ProjectDetail>(`/v1/projects/${projectId}`, { method: 'PATCH', body: input }),
    onSuccess: (detail) => {
      queryClient.setQueryData(['project', projectId], detail);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      apiFetch<void>(`/v1/projects/${projectId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export interface VersionView {
  id: string;
  projectId: string;
  version: number;
  note: string | null;
  createdAt: string;

  /*
   * Phase 2 metadata. `null` where a row written before Phase 2 simply has
   * nothing recorded — so a client never has to distinguish "not recorded" from
   * "not sent".
   */
  parentVersion: number | null;
  changeType: VersionChangeType | null;
  changeSummary: VersionChangeSummary | null;
  publishedAt: string | null;
  rollbackSourceVersion: number | null;
  /**
   * Derived server-side from the artifact rows and the published pointer, so it
   * is optional on the wire rather than a field the client could compute.
   */
  status?: VersionStatus;
}

export function useVersions(projectId: string | null) {
  return useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => apiFetch<ListEnvelope<VersionView>>(`/v1/projects/${projectId}/versions`),
    enabled: projectId !== null,
  });
}

/**
 * Roll back to a version — by seeding the draft, not by writing the definition.
 *
 * §22: a rollback is the edit most likely to remove fields and break callers,
 * so it goes through the same review every ordinary edit does. The mutation
 * therefore resolves to a **draft**, and the caller's next move is the review
 * screen, not a success toast on a page that already changed.
 *
 * ## Why both caches are seeded rather than invalidated
 *
 * The response carries the draft *and* its analysis, so there is nothing left
 * to fetch. Invalidating `draft` would refetch through `POST /draft` and get
 * back the draft just seeded; invalidating `impact` would recompute a diff the
 * server already sent. The review screen would spend both round trips on a
 * skeleton.
 *
 * `versions` is deliberately not invalidated: a restore creates no version and
 * touches no existing one. The commit is what advances history.
 */
export function useRestoreVersion(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      apiFetch<RestoredDraft>(`/v1/projects/${projectId}/versions/${version}/restore`, {
        method: 'POST',
      }),
    onSuccess: (restored) => {
      const { analysis, ...draft } = restored;
      queryClient.setQueryData(draftKey(projectId), draft);
      queryClient.setQueryData(impactKey(projectId), analysis);
      // The project itself gains an open draft, which its detail payload
      // reports, so that one is genuinely stale.
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

/**
 * Compare two versions.
 *
 * `staleTime: Infinity` because both snapshots are immutable, so the answer is
 * too — flipping between pairs is then instant rather than a refetch. The one
 * exception is a side resolved from the live definition (`source: 'project'`),
 * which can move; that is rare enough that a manual refetch is the right
 * trade rather than making every comparison re-fetch.
 */
export function useVersionComparison(projectId: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: ['version-compare', projectId, from, to],
    queryFn: () =>
      apiFetch<VersionComparison>(
        `/v1/projects/${projectId}/versions/compare?from=${from}&to=${to}`,
      ),
    enabled: from !== null && to !== null,
    staleTime: Infinity,
  });
}

/** What `POST /versions/:version/publish` answers with. */
export interface PublishResult {
  published: boolean;
  /** `'already-published'` on the idempotent no-op. */
  reason?: string;
  version: number;
  publishedVersion: number;
  hosted: { url: string | null; expiresAt: string | null };
  /** Optional artifacts that failed. The version is live and incomplete. */
  degraded: string[];
  /** True when mock data was not reseeded, so records may predate this schema. */
  staleDataRisk: boolean;
}

/**
 * Publish a version — the explicit action that moves the live pointer.
 *
 * Invalidates the project as well as the version list, because publishing
 * changes `publishedVersion`, `status` and `hosted` on the project document, and
 * every screen showing "live" reads those.
 */
export function usePublishVersion(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      apiFetch<PublishResult>(`/v1/projects/${projectId}/versions/${version}/publish`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['versions', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** Download an artifact through the authorized API (doc 13 §6) and save it.
 * Pass `version` to target an artifact pinned below the current version
 * (per-artifact skew after a partial regen); omit for the current version. */
export async function downloadArtifact(
  projectId: string,
  artifactType: string,
  version?: number,
): Promise<void> {
  const { apiBaseUrl, currentAccessToken } = await import('./api-client');
  const token = currentAccessToken();
  const qs = version !== undefined ? `?version=${version}` : '';
  const response = await fetch(
    `${apiBaseUrl()}/v1/projects/${projectId}/artifacts/${artifactType}/download${qs}`,
    { headers: token !== null ? { authorization: `Bearer ${token}` } : {} },
  );
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? artifactDownloadFilename(artifactType);

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function artifactDownloadFilename(artifactType: string): string {
  if (artifactType === 'export_zip') {
    return 'export.zip';
  }
  if (artifactType === 'openapi' || artifactType === 'postman' || artifactType === 'hosted_api') {
    return `${artifactType}.json`;
  }
  return `${artifactType}.ts`;
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Drafts (Phase 1)
// ---------------------------------------------------------------------------

const draftKey = (projectId: string | null) => ['draft', projectId];
const impactKey = (projectId: string | null) => ['draft-impact', projectId];

/**
 * The editable copy of a project's definition, forking one if none is open.
 *
 * **Loaded with POST, deliberately.** `POST /draft` is idempotent by contract —
 * it forks when nothing is open and returns the existing draft otherwise — so it
 * is a read with an upsert, and using it as the loader means opening the editor
 * is exactly one request that cannot fail with "no draft is open".
 *
 * The alternative was `GET /draft`, then watching for its 404 to trigger a POST.
 * That worked, but it made a 404 part of the ordinary happy path, which is both
 * two requests and a thing that makes anyone reading a network panel believe
 * something is broken.
 */
export function useDraft(projectId: string | null) {
  return useQuery({
    queryKey: draftKey(projectId),
    queryFn: () => apiFetch<ProjectDraft>(`/v1/projects/${projectId}/draft`, { method: 'POST' }),
    enabled: projectId !== null,
    // A failure here is a real failure — a missing project, a revoked session —
    // not the "nothing open yet" case the GET had to tolerate.
    retry: false,
  });
}

/**
 * The review-changes analysis: diff, affected APIs, and what to regenerate.
 *
 * Fetched from the server rather than computed here, deliberately. The
 * dependency graph and impact rules live in `@instantmockapi/ips`; a second
 * implementation in the browser would eventually disagree with the one the
 * commit endpoint enforces, and the user would be shown two different answers to
 * the same question.
 */
export function useDraftImpact(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: impactKey(projectId),
    queryFn: () => apiFetch<DraftAnalysis>(`/v1/projects/${projectId}/draft/impact`),
    enabled: projectId !== null && enabled,
    retry: false,
  });
}

/**
 * Adopt a draft the server just returned, rather than refetching it.
 *
 * Every mutation that leaves a draft in place answers with the draft itself, so
 * invalidating would throw that response away and ask for it again. The impact
 * analysis genuinely has to be recomputed, so that one is invalidated.
 */
function useAdoptDraft(projectId: string) {
  const queryClient = useQueryClient();
  return async (draft: ProjectDraft) => {
    queryClient.setQueryData(draftKey(projectId), draft);
    await queryClient.invalidateQueries({ queryKey: impactKey(projectId) });
  };
}

/**
 * Forget a draft that no longer exists.
 *
 * Used after commit and discard, both of which delete it. `invalidateQueries`
 * would be wrong here in a way that is easy to miss and obvious once seen: it
 * refetches, and refetching a resource you have just deleted is a guaranteed
 * 404 — two of them, since the impact query is mounted on the review step. The
 * requests failed correctly and meant nothing, which is the worst kind of error
 * to leave in a log.
 *
 * The project itself is invalidated rather than removed: a commit moves its
 * `currentVersion` and status, and it very much still exists.
 */
function useForgetDraft(projectId: string) {
  const queryClient = useQueryClient();
  return async () => {
    queryClient.removeQueries({ queryKey: draftKey(projectId) });
    queryClient.removeQueries({ queryKey: impactKey(projectId) });
    await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  };
}

export function useSaveDraft(projectId: string) {
  const adopt = useAdoptDraft(projectId);
  return useMutation({
    mutationFn: (input: { ips?: unknown; generationConfig?: unknown }) =>
      apiFetch<ProjectDraft>(`/v1/projects/${projectId}/draft`, { method: 'PATCH', body: input }),
    onSuccess: adopt,
  });
}

export function useDiscardDraft(projectId: string) {
  const forget = useForgetDraft(projectId);
  return useMutation({
    mutationFn: () => apiFetch<void>(`/v1/projects/${projectId}/draft`, { method: 'DELETE' }),
    onSuccess: forget,
  });
}

/** Discard a stale draft and fork a fresh one from the current definition. */
export function useReforkDraft(projectId: string) {
  const adopt = useAdoptDraft(projectId);
  return useMutation({
    mutationFn: () =>
      apiFetch<ProjectDraft>(`/v1/projects/${projectId}/draft/refork`, { method: 'POST' }),
    onSuccess: adopt,
  });
}

/**
 * Commit the draft: it becomes the new definition, pending regeneration.
 *
 * `acknowledgeImpact` must be the `digest` from the analysis the user actually
 * saw. Passing a stale one is refused — which is the point, since a boolean flag
 * could be replayed across an edit the user never reviewed.
 */
export function useCommitDraft(projectId: string) {
  const forget = useForgetDraft(projectId);
  return useMutation({
    mutationFn: (input: { acknowledgeImpact?: string; artifacts?: string[]; note?: string }) =>
      apiFetch<DraftCommitResult>(`/v1/projects/${projectId}/draft/commit`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: forget,
  });
}

// ---------------------------------------------------------------------------
// Technical Notes (Phase 4 §10)
// ---------------------------------------------------------------------------

/**
 * The human-readable Technical Notes, as markdown.
 *
 * Built on demand by the API rather than stored as an artifact, so there is no
 * version to pass and nothing to be stale against: the document is a pure
 * function of the definition. That also means it is not in the artifact cache —
 * the query key is its own.
 */
export function useTechnicalNotes(projectId: string | null) {
  return useQuery({
    queryKey: ['technical-notes', projectId],
    queryFn: () =>
      apiFetch<{ version: number; markdown: string }>(`/v1/projects/${projectId}/technical-notes`),
    enabled: projectId !== null,
  });
}

/**
 * The AI-ready context (§7). Idle until the view is opened.
 *
 * `enabled` rather than eager: a user who only reads the notes should not pay
 * for a second document, and the two are separate routes precisely so that
 * choice exists.
 */
export function useAiContext(projectId: string | null, wanted: boolean) {
  return useQuery({
    queryKey: ['ai-context', projectId],
    queryFn: () =>
      apiFetch<{ version: number; context: string }>(
        `/v1/projects/${projectId}/technical-notes/ai`,
      ),
    enabled: projectId !== null && wanted,
  });
}

/**
 * The project's blueprint (Phase 4 §17).
 *
 * Idle until asked for, like the AI context: it is a whole definition and most
 * visits to the tab do not want one.
 *
 * The response body *is* the file — the API returns the blueprint bare rather
 * than wrapped — so what gets downloaded is what the API returned, and a client
 * that unwrapped it wrongly could not produce a file the importer rejects.
 */
export function useBlueprint(projectId: string | null, wanted: boolean) {
  return useQuery({
    queryKey: ['blueprint', projectId],
    queryFn: () => apiFetch<Record<string, unknown>>(`/v1/projects/${projectId}/blueprint`),
    enabled: projectId !== null && wanted,
  });
}

/**
 * Import a blueprint as a new project (Phase 4 §15).
 *
 * A create, so it invalidates the project list exactly as `useCreateProject`
 * does. It does not generate: that is a second call, which is also how the
 * wizard works — create, review, then Generate.
 */
export function useImportBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { blueprint: unknown; name?: string; description?: string }) =>
      apiFetch<ProjectDetail>('/v1/projects/import', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/**
 * Duplicate a project through the blueprint pathway (Phase 4 §19).
 *
 * A create, so the project list is invalidated. Like import, it does not
 * generate — the copy is a draft and the caller decides when to spend the work.
 */
export function useDuplicateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string } = {}) =>
      apiFetch<ProjectDetail>(`/v1/projects/${projectId}/duplicate`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

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
  DashboardView,
  ArtifactView,
  AuthAcknowledgement,
  AuthSession,
  GenerationConfig,
  JobView,
  ListEnvelope,
  ProjectDetail,
  ProjectSummary,
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
    queryFn: () => apiFetch<ListEnvelope<ProjectSummary>>(`/v1/projects${qs ? `?${qs}` : ''}`),
  });
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<ProjectDetail>(`/v1/projects/${projectId}`),
    enabled: projectId !== null,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      kind?: 'project' | 'single';
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
      apiFetch<{ data: ArtifactView[]; meta: { version: number } }>(
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
}

export function useVersions(projectId: string | null) {
  return useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => apiFetch<ListEnvelope<VersionView>>(`/v1/projects/${projectId}/versions`),
    enabled: projectId !== null,
  });
}

export function useRestoreVersion(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      apiFetch<ProjectDetail>(`/v1/projects/${projectId}/versions/${version}/restore`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['versions', projectId] });
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

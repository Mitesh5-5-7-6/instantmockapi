'use client';

/**
 * TanStack Query hooks over the platform API — the client data layer
 * (doc 08, Phase 6). Screens consume these; no component fetches directly.
 */

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, loadTokens, saveTokens, subscribeJobStream } from './api-client';
import type {
  ApiUser,
  ArtifactContent,
  ArtifactView,
  AuthTokens,
  GenerationConfig,
  JobView,
  ListEnvelope,
  ProjectDetail,
  ProjectSummary,
} from './api-types';

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (email: string) => {
      const tokens = await apiFetch<AuthTokens>('/v1/auth/login', {
        method: 'POST',
        body: { email },
      });
      saveTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      return tokens.user;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await apiFetch('/v1/auth/logout', { method: 'POST' });
      } finally {
        saveTokens(null);
      }
    },
    onSuccess: () => queryClient.clear(),
  });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<{ user: ApiUser }>('/v1/me'),
    enabled: loadTokens() !== null,
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
    mutationFn: (input: { name: string; inputSource: { type: string; raw: unknown } }) =>
      apiFetch<ProjectDetail>('/v1/projects', { method: 'POST', body: input }),
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

/** Download an artifact through the authorized API (doc 13 §6) and save it. */
export async function downloadArtifact(projectId: string, artifactType: string): Promise<void> {
  const { apiBaseUrl, loadTokens } = await import('./api-client');
  const tokens = loadTokens();
  const response = await fetch(
    `${apiBaseUrl()}/v1/projects/${projectId}/artifacts/${artifactType}/download`,
    { headers: tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {} },
  );
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `${artifactType}.json`;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

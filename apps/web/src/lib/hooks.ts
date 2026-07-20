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
    const abort = subscribeJobStream(jobId, (snapshot) => {
      queryClient.setQueryData(['job', jobId], snapshot);
    });
    return abort;
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

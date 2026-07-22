/**
 * Platform API response shapes (doc 08). The web app talks HTTP only
 * (doc 05); these mirror the API's serializers, not the DB models.
 */

export type ProjectStatus = 'draft' | 'generating' | 'active' | 'expired';
export type ArtifactStatus = 'pending' | 'generating' | 'completed' | 'failed';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed_partial';

export interface ApiUser {
  id: string;
  email: string;
  plan: 'free' | 'pro' | 'enterprise';
  authProvider: 'google' | 'email';
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ApiUser;
}

export interface GenerationConfig {
  validators: string[];
  types: string[];
  methods: string[];
  mockRecords: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  currentVersion: number;
  inputType: 'json' | 'swagger' | 'builder' | 'docs';
  hosted: { url: string | null; expiresAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  ips: unknown;
  generationConfig: GenerationConfig;
}

export interface JobWorkerView {
  worker: string;
  artifactType: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface JobView {
  id: string;
  projectId: string;
  version: number;
  type: 'full' | 'partial';
  status: JobStatus;
  progress: { settled: number; total: number; percent: number };
  requestedArtifacts: string[];
  workers: JobWorkerView[];
  createdAt: string;
  completedAt: string | null;
}

export interface ArtifactView {
  id: string;
  projectId: string;
  artifactType: string;
  version: number;
  status: ArtifactStatus;
  workerId: string | null;
  generatedAt: string | null;
  errorMessage: string | null;
  storageRef: string | null;
}

export interface ArtifactContent {
  artifactType: string;
  version: number;
  files: Record<string, string>;
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
}

export interface ListEnvelope<T> {
  data: T[];
  meta: ListMeta;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: { path: string; issue: string }[];
  };
}

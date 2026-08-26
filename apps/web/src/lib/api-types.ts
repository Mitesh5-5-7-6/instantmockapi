/**
 * Platform API response shapes (doc 08). The web app talks HTTP only
 * (doc 05); these mirror the API's serializers, not the DB models.
 */

export type ProjectStatus = 'draft' | 'generating' | 'active' | 'expired';
export type ArtifactStatus = 'pending' | 'generating' | 'completed' | 'failed';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed_partial';

export interface PlanLimits {
  /** null means unlimited — both server-side sentinels normalise to it. */
  maxProjects: number | null;
  maxConcurrentJobs: number | null;
  hostedApiLifetimeDays: number;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  limits: PlanLimits;
  plan: 'free' | 'pro' | 'enterprise';
  authProvider: 'google' | 'email';
  createdAt: string;
}

/**
 * What the API returns from every route that establishes a session.
 *
 * There is deliberately **no refreshToken field**: the refresh token comes back
 * as an httpOnly cookie the browser stores and this code cannot read. Adding it
 * to the body would put a durable credential back where script can reach it,
 * which is the thing the cookie exists to prevent.
 */
export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: ApiUser;
}

/** Signup, forgot-password and resend-verification all answer in this shape. */
export interface AuthAcknowledgement {
  ok: true;
  message: string;
  /**
   * Present when a sign-in attempt found an account with no password and emailed
   * a link to set one — neither a success nor a failure (doc 13 D3).
   */
  passwordSetupRequired?: boolean;
}

/** Hosted-API query capabilities (doc 19 §Phase 4). */
export interface QueryFeatures {
  search: boolean;
  filter: boolean;
  sort: boolean;
  include: boolean;
}

export interface GenerationConfig {
  validators: string[];
  types: string[];
  methods: string[];
  mockRecords: number;
  /**
   * Optional on the wire because documents written before the query layer have
   * none. The wizard always sends a complete block: the API treats the config as
   * a full replacement, so omitting it switches every feature off.
   */
  features?: QueryFeatures;
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: 'project' | 'single';
  publicId: string | null;
  slug: string | null;
  description: string | null;
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

/* ── Dashboard (GET /v1/dashboard) ── */

export interface RequestSeriesBucket {
  date: string;
  count: number;
  serverErrors: number;
  /** True for today, whose day has not finished — so the last point always dips. */
  partial: boolean;
}

export type ActivityType =
  'project.created' | 'project.imported' | 'project.built' | 'version.generated' | 'job.failed';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  at: string;
  projectId: string;
  projectName: string;
  text: string;
}

/**
 * The dashboard payload.
 *
 * Every rate is `number | null`, and `null` means "no comparable data" rather
 * than zero — a window with no traffic has no success rate, and "up from
 * nothing" has no percentage. Rendering those as 0% or +∞% is the failure this
 * shape exists to prevent.
 */
export interface DashboardView {
  window: { days: number; from: string; to: string; tz: 'UTC'; retentionDays: number };
  projects: { total: number; createdInWindow: number; byStatus: Record<string, number> };
  endpoints: { total: number; inProjectsCreatedThisMonth: number };
  requests: {
    total: number;
    previousTotal: number;
    changePercent: number | null;
    successRate: number | null;
    clientErrorRate: number | null;
    serverErrorRate: number | null;
    avgDurationMs: number | null;
    /** How many rows carried a duration. Older rows predate the field. */
    durationSampleCount: number;
    series: RequestSeriesBucket[];
    byProject: Record<string, number>;
    note: string;
  };
  hosted: { live: number; total: number; soonestExpiresAt: string | null };
  plan: {
    tier: 'free' | 'pro' | 'enterprise';
    projects: { used: number; limit: number | null };
    concurrentJobs: { used: number; limit: number | null };
    hostedApiLifetimeDays: number;
  };
  activity: ActivityEvent[];
}

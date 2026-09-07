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
  /**
   * The DEFINITION version — what the user is editing.
   *
   * Not what the hosted API serves. The two diverge the moment anything is
   * edited, so a screen that shows this and calls it "live" is wrong; use
   * `publishedVersion` for that.
   */
  currentVersion: number;
  /**
   * The version the hosted API serves, or `null` when nothing is live yet.
   *
   * `null` is a real state — a project that has never generated — and is a
   * different statement from `1`, which is why the two are not collapsed.
   */
  publishedVersion: number | null;
  /** `currentVersion > publishedVersion`: edits are waiting to be generated. */
  pendingRegeneration: boolean;
  inputType: 'json' | 'swagger' | 'builder' | 'docs';
  hosted: { url: string | null; expiresAt: string | null };
  createdAt: string;
  updatedAt: string;
}

/** Derived, never stored — see `versionStatus` in `packages/shared`. */
export type VersionStatus =
  'PUBLISHED' | 'SUPERSEDED' | 'READY' | 'DEGRADED' | 'GENERATING' | 'FAILED' | 'PENDING';

export type VersionChangeType = 'INITIAL' | 'FEATURE' | 'BREAKING' | 'ROLLBACK' | 'REGENERATION';

/** §3's change counts, for the history list's one-line summary. */
export interface VersionChangeSummary {
  entitiesAdded: number;
  entitiesRemoved: number;
  entitiesModified: number;
  fieldsAdded: number;
  fieldsRemoved: number;
  fieldsModified: number;
  relationsAdded: number;
  relationsRemoved: number;
  relationsModified: number;
  endpointsAdded: number;
  endpointsRemoved: number;
  endpointsModified: number;
}

/**
 * What `GET /v1/projects` adds to each row.
 *
 * The list endpoint has been computing these all along — `endpointCount` from
 * the stored IPS and `requestCount` from an `ApiLog` aggregation — and the
 * client was discarding them because the type never declared them. They are
 * exactly the columns a table wants, so a card grid was the shape hiding the
 * most useful data on the screen.
 */
export interface ProjectListRow extends ProjectSummary {
  endpointCount: number;
  /** Requests in the last `requestWindowDays`, not a lifetime total. */
  requestCount: number;
  /** Bounded by the ApiLog 30-day TTL, so it can never mean "ever". */
  requestWindowDays: number;
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
    /**
     * Correlation id, also sent as the `x-request-id` header.
     *
     * Optional because a response that is not ours — a gateway 502, an HTML
     * error page — has no envelope at all, and because the header is the
     * preferred source.
     */
    requestId?: string;
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

/* ── Project metrics (GET /v1/projects/:id/metrics) ── */

/**
 * Which URL shape a request addressed. Mirrors `ApiLog.shape`.
 *
 * Null on rows logged before per-endpoint attribution existed, and on a request
 * that resolved to the project but not to an entity.
 */
export type ApiLogShape = 'index' | 'collection' | 'record';

export interface EndpointUsage {
  method: string;
  /** Canonical entity path; null for the discovery document. */
  entity: string | null;
  shape: ApiLogShape | null;
  count: number;
  avgDurationMs: number | null;
  durationSampleCount: number;
  serverErrors: number;
}

/**
 * One project's traffic.
 *
 * Same null discipline as `DashboardView`: every rate is `number | null`, and null
 * means "nothing comparable to measure" rather than zero. A project with no
 * traffic has no success rate, and 0% would read as "everything failed".
 */
export interface ProjectMetricsView {
  window: { days: number; from: string; to: string; tz: 'UTC'; retentionDays: number };
  /** Derived from the current schema × enabled methods, not from traffic. */
  endpoints: { total: number; entities: number };
  requests: {
    total: number;
    previousTotal: number;
    changePercent: number | null;
    successRate: number | null;
    clientErrorRate: number | null;
    serverErrorRate: number | null;
    avgDurationMs: number | null;
    previousAvgDurationMs: number | null;
    /** Signed; negative is faster. Null unless both windows were sampled. */
    durationChangeMs: number | null;
    /** How many requests carried a duration — the mean is over these only. */
    durationSampleCount: number;
    series: RequestSeriesBucket[];
  };
  topEndpoints: EndpointUsage[];
  /** Counted in `requests.total` but absent from `topEndpoints`. */
  unattributedRequests: number;
  /** Set only when `unattributedRequests > 0`, explaining the gap. */
  endpointNote: string | null;
  activity: ActivityEvent[];
}

/* ── Project logs (GET /v1/projects/:id/logs) ── */

export type LogStatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export interface ApiLogRow {
  id: string;
  at: string;
  method: string;
  /** The URL exactly as requested — query string and record id included. */
  path: string;
  status: number;
  /** Null on rows predating the field. Render as `—`, never `0ms`. */
  durationMs: number | null;
  entity: string | null;
  shape: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ProjectLogsParams {
  page?: number;
  limit?: number;
  days?: number;
  method?: string;
  status?: LogStatusClass;
  entity?: string;
  /** Prefix match on the path. */
  q?: string;
}

export interface ProjectLogsEnvelope {
  data: ApiLogRow[];
  meta: { page: number; limit: number; total: number; retentionDays: number };
}

// ---------------------------------------------------------------------------
// Drafts and impact analysis (Phase 1)
// ---------------------------------------------------------------------------

/**
 * The five risk levels, worst last.
 *
 * Mirrors `ChangeRisk` in `@instantmockapi/ips`. Restated rather than imported
 * because `apps/web` may not import server packages, and the union is small
 * enough that a drift would fail the first render rather than lurk.
 */
export type ChangeRisk = 'SAFE' | 'INFO' | 'WARNING' | 'ROUTING' | 'BREAKING';

/** Which part of an endpoint a dependency lands on. */
export type ImpactFacet = 'request' | 'response' | 'query' | 'path';

/** §11's four-way shape of a change, for the `+ − ~` glyph and the counts. */
export type ChangeType = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'RENAMED';

/**
 * §12's axis: do existing callers break — yes, maybe, or no.
 *
 * **Never rendered in the same row as `risk`.** They answer different questions
 * and eight of the change kinds legitimately disagree (a changed default is
 * `SAFE` and `POTENTIALLY_BREAKING`), so side by side they read as a
 * contradiction. The comparison page shows this; the commit dialog shows `risk`.
 */
export type ChangeImpact = 'BREAKING' | 'POTENTIALLY_BREAKING' | 'NON_BREAKING';

/** How the two sides of a change were paired up. */
export type MatchBasis = 'id' | 'name';

/** A value too large to send whole. */
export interface TruncatedValue {
  __truncated: true;
  preview: string;
  bytes: number;
}

export interface DraftChange {
  kind: string;
  risk: ChangeRisk;
  aspect: 'read' | 'write' | 'both' | 'routing' | 'none';
  entity: string | null;
  field: string | null;
  path: string | null;
  before: unknown;
  after: unknown;
  summary: string;

  /*
   * Phase 2, additive — and optional here because this shape predates them.
   *
   * Required on the comparison types below instead: an existing shape being
   * extended has to tolerate an older server, while a brand-new endpoint always
   * sends its own fields.
   */
  entityId?: string | null;
  fieldId?: string | null;
  relationId?: string | null;
  relationName?: string | null;
  changeType?: ChangeType;
  impact?: ChangeImpact;
  matchedBy?: MatchBasis;
}

/** Alias for new code: this shape is no longer draft-specific. */
export type SchemaChangeView = DraftChange;

/** One answer to "why is this API affected?". */
export interface ImpactReason {
  /** Readable source, e.g. `User.email`. */
  source: string;
  /** Precise pointer, e.g. `request.body.email`. */
  reason: string;
  facet: ImpactFacet;
  /** The change kind that caused it. */
  change: string;
  summary: string;
}

export interface AffectedEndpoint {
  method: string;
  path: string;
  entity: string | null;
  risk: ChangeRisk;
  reasons: ImpactReason[];
}

export interface UnaffectedEndpoint {
  method: string;
  path: string;
  entity: string | null;
}

export interface DraftAnalysis {
  stale: boolean;
  baseVersion: number;
  currentVersion: number;
  /** Worst risk across every change; null when nothing changed. */
  risk: ChangeRisk | null;
  summary: Record<ChangeRisk, number>;
  /** A commit must echo `digest` back as `acknowledgeImpact` when this is true. */
  requiresAcknowledgement: boolean;
  /**
   * True when a change could not be matched to a graph node.
   *
   * The not-affected list must not be presented as a guarantee when this is set.
   */
  incomplete: boolean;
  /** Bind an acknowledgement to this exact draft state. */
  digest: string;
  changes: DraftChange[];
  affected: AffectedEndpoint[];
  unaffected: UnaffectedEndpoint[];
  artifacts: string[];
}

/* ── Version comparison (Phase 2 §24, §36, §37) ────────────────────────────
 *
 * Restated rather than imported, because `apps/web` may not import server
 * packages. These mirror `packages/ips/src/grouping.ts` one for one — the same
 * discipline `ChangeRisk` already follows: the server computes, the client
 * renders and restates only the types.
 */

export interface ChangeGroupCounts {
  total: number;
  added: number;
  removed: number;
  modified: number;
  renamed: number;
  breaking: number;
  potentiallyBreaking: number;
  nonBreaking: number;
}

/** What happened to a group as a whole, for its glyph. */
export type GroupStatus = 'added' | 'removed' | 'renamed' | 'modified';

export interface GroupedChangeView {
  change: SchemaChangeView;
  changeType: ChangeType;
  impact: ChangeImpact;
}

export interface FieldGroupView {
  /** Stable React key: the element id, else a name-derived fallback. */
  key: string;
  fieldId: string | null;
  /** Dotted path as the `to` side spells it — `address.city`. */
  path: string;
  name: string;
  previousName: string | null;
  status: GroupStatus;
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: MatchBasis;
  changes: GroupedChangeView[];
}

export interface RelationGroupView {
  key: string;
  relationId: string | null;
  name: string;
  previousName: string | null;
  status: GroupStatus;
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: MatchBasis;
  changes: GroupedChangeView[];
}

export interface EntityGroupView {
  key: string;
  entityId: string | null;
  name: string;
  previousName: string | null;
  status: GroupStatus;
  /** Uncapped: the entity's real totals, whatever survived truncation below. */
  counts: ChangeGroupCounts;
  impact: ChangeImpact;
  matchedBy: MatchBasis;
  /** §37's "APIs" section — endpoints this entity's changes reach. */
  endpoints: { method: string; path: string }[];
  /** Changes about the entity itself: rename, description, identity. */
  own: GroupedChangeView[];
  fields: FieldGroupView[];
  relations: RelationGroupView[];
  /** Non-zero when this group was capped. */
  omittedChanges: number;
}

export interface ChangeTreeView {
  entities: EntityGroupView[];
  /** Changes belonging to no entity: methods, query features, seeding. */
  project: {
    changes: GroupedChangeView[];
    counts: ChangeGroupCounts;
    impact: ChangeImpact | null;
  };
  counts: ChangeGroupCounts;
}

/** How much of a comparison rested on names rather than on stable ids. */
export interface MatchingReportView {
  byId: number;
  byName: number;
  nameMatchedEntities: string[];
  /**
   * True when name matching was used anywhere.
   *
   * The consequence the page must state: within a name-matched scope a rename
   * reads as one removal plus one addition, because with no stable id the two
   * are indistinguishable.
   */
  renamesUndetectable: boolean;
  /** Neither side carried a stable id — the whole comparison rests on names. */
  legacyBothSides: boolean;
}

export interface VersionRefView {
  version: number;
  note: string | null;
  createdAt: string | null;
  /** `'project'` for a version authored but never generated. */
  source: 'version' | 'project';
}

export interface VersionComparison {
  from: VersionRefView;
  to: VersionRefView;
  /** `'backward'` describes a hypothetical — what restoring would do. */
  direction: 'forward' | 'backward';
  summary: {
    total: number;
    changeTypes: Record<ChangeType, number>;
    impact: Record<ChangeImpact, number>;
    risk: ChangeRisk | null;
    affectedEntities: number;
    affectedEndpoints: number;
    affectedArtifacts: number;
  };
  matching: MatchingReportView;
  tree: ChangeTreeView;
  /** Non-null when the body was capped. The counts above are never capped. */
  truncated: { omittedChanges: number; omittedEntities: number } | null;
  affected: AffectedEndpoint[];
  unaffected: UnaffectedEndpoint[];
  artifacts: string[];
  incomplete: boolean;
}

export interface ProjectDraft {
  projectId: string;
  baseVersion: number;
  currentVersion: number;
  stale: boolean;
  ips: unknown;
  generationConfig: GenerationConfig;
  createdAt: string;
  updatedAt: string;
}

export interface DraftCommitResult {
  committed: boolean;
  /** The new definition version, or null when nothing changed. */
  version: number | null;
  /** What the runtime is still serving. A commit never moves this. */
  publishedVersion: number;
  job: { jobId: string; status: string } | null;
  reason?: 'no-changes';
  analysis: DraftAnalysis;
}

/**
 * Everything behind `GET /v1/projects/:id/logs`.
 *
 * A plain paginated read, deliberately unlike `project-metrics-service.ts`: that
 * one aggregates because the question is "how much"; this one returns rows
 * because the question is "did *my* request arrive, and what did it get back".
 *
 * The rows are returned close to verbatim. `path` in particular is **not**
 * normalised here — a log's whole value is that it shows what was literally
 * called, query string and record id included. `entity`/`shape` are the
 * normalised view, and they are what the metrics service groups on.
 */

// Type-only: `mongoose` is not a dependency of this app (it arrives via
// @instantmockapi/db), so a value import would resolve at build time and then
// fail at runtime with "Cannot find package 'mongoose'".
import type { Types } from 'mongoose';
import { ApiLog, type IApiLog } from '@instantmockapi/db';

/**
 * The filter this builds, written out rather than borrowed.
 *
 * `FilterQuery` is not reachable as a named export from the mongoose types this
 * app resolves — mongoose arrives transitively via `@instantmockapi/db`, and only
 * the namespace members hang off its default export. Deriving it from
 * `Parameters<typeof ApiLog.find>` does not work either: `find` is overloaded, so
 * that resolves to the returned `Query` rather than the filter.
 *
 * Spelling out the five fields is better than either. It is exactly what the
 * builder below sets, so an unintended key is a compile error instead of a filter
 * Mongo silently ignores.
 */
interface LogFilter {
  projectId: Types.ObjectId;
  at: { $gte: Date };
  method?: string;
  status?: { $gte: number; $lt: number };
  entity?: string;
  path?: { $regex: string };
}

/**
 * Status classes, because that is how people actually think about responses.
 *
 * Exact-code filtering is the wrong grain: nobody wants "show me the 409s"
 * nearly as often as "show me what failed", and the runtime returns several
 * different 4xx by design.
 */
export const LOG_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export type LogStatusClass = (typeof LOG_STATUS_CLASSES)[number];

/** Hard ceiling on a page, whatever the caller asks for. */
export const LOG_PAGE_MAX = 100;
export const LOG_PAGE_DEFAULT = 50;

export interface ProjectLogsQuery {
  page: number;
  limit: number;
  days: number;
  method?: string;
  status?: LogStatusClass;
  entity?: string;
  /** Prefix match on the request path. */
  q?: string;
}

export interface ApiLogRow {
  id: string;
  at: string;
  method: string;
  path: string;
  status: number;
  durationMs: number | null;
  entity: string | null;
  shape: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ProjectLogsResult {
  data: ApiLogRow[];
  meta: { page: number; limit: number; total: number; retentionDays: number };
}

const LOG_RETENTION_DAYS = 30;

/** Inclusive-exclusive bounds for a status class. */
function statusBounds(statusClass: LogStatusClass): { $gte: number; $lt: number } {
  const hundreds = Number(statusClass[0]) * 100;
  return { $gte: hundreds, $lt: hundreds + 100 };
}

/**
 * Escape a value going into a regex.
 *
 * The path filter is user input reaching a `$regex`. Unescaped, `(` alone is an
 * invalid-regex error and `.*` an accidental full scan — and a crafted pattern is
 * a denial-of-service via catastrophic backtracking against every row in the
 * window.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the filter.
 *
 * `projectId` and the time bound come first and are the only indexed part
 * (`{ projectId: 1, at: -1 }`); everything else narrows within that already-small
 * set, which is why none of the other fields carry an index.
 */
function buildFilter(projectId: Types.ObjectId, query: ProjectLogsQuery, now: Date): LogFilter {
  const from = new Date(now.getTime() - query.days * 24 * 60 * 60 * 1000);
  const filter: LogFilter = { projectId, at: { $gte: from } };

  if (query.method !== undefined) {
    filter.method = query.method.toUpperCase();
  }
  if (query.status !== undefined) {
    filter.status = statusBounds(query.status);
  }
  if (query.entity !== undefined) {
    filter.entity = query.entity.toLowerCase();
  }
  if (query.q !== undefined && query.q !== '') {
    // Anchored, so it is a prefix rather than a substring search. An unanchored
    // pattern cannot use an index and scans every row in the window; a prefix
    // covers the real question ("everything under /products") at bounded cost.
    filter.path = { $regex: `^${escapeRegex(query.q)}` };
  }

  return filter;
}

function toRow(log: IApiLog): ApiLogRow {
  return {
    id: String(log._id),
    at: log.at.toISOString(),
    method: log.method,
    path: log.path,
    // Null, never 0. Rows predating the duration field carry no value, and
    // rendering those as `0ms` would claim an impossibly fast response.
    durationMs: log.durationMs ?? null,
    status: log.status,
    entity: log.entity ?? null,
    shape: log.shape ?? null,
    ip: log.ip ?? null,
    userAgent: log.userAgent ?? null,
  };
}

export async function listProjectLogs(
  projectId: Types.ObjectId,
  query: ProjectLogsQuery,
  now: Date = new Date(),
): Promise<ProjectLogsResult> {
  const limit = Math.min(Math.max(1, query.limit), LOG_PAGE_MAX);
  const page = Math.max(1, query.page);
  const filter = buildFilter(projectId, query, now);

  // Counted in the same round trip as the page, so the pager cannot disagree with
  // the rows beside it.
  const [rows, total] = await Promise.all([
    ApiLog.find(filter)
      // Descending `at` is served directly by the compound index — no in-memory
      // sort, however many rows the window holds.
      .sort({ at: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ApiLog.countDocuments(filter),
  ]);

  return {
    data: rows.map(toRow),
    meta: { page, limit, total, retentionDays: LOG_RETENTION_DAYS },
  };
}

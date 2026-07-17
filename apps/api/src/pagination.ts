/**
 * Pagination, sorting, and search helpers (doc 08 §6).
 *
 * Every list endpoint responds with `{ data: [...], meta: { page, limit, total } }`;
 * `limit` is capped (default 20, max from config) rather than rejected.
 */

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

export function parsePagination(
  query: { page?: number; limit?: number },
  maxLimit: number,
): PageParams {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 20)), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

export function listEnvelope<T>(data: T[], params: PageParams, total: number) {
  return { data, meta: { page: params.page, limit: params.limit, total } };
}

/** Parse `?sort=-updatedAt` (leading `-` = descending) into a mongo sort spec. */
export function parseSort(sort: string): Record<string, 1 | -1> {
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  return { [field]: descending ? -1 : 1 };
}

/** Escape user input before embedding it in a $regex search. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

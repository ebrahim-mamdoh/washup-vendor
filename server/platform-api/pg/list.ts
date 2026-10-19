import "server-only";

import type { Pagination } from "@/types/common";
import type postgres from "postgres";

import type { Q } from "./sql";

/**
 * List helpers for SQL-backed endpoints: same query params and response shapes
 * as the mock helpers in `../http.ts` (`?page&per_page&search&sort&order`), but
 * filtering, sorting and paging run in Postgres.
 */

/** `?search=` as an ILIKE pattern (`%term%`, wildcards escaped), or null. */
export function searchPattern(query: URLSearchParams): string | null {
  const term = query.get("search")?.trim();
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `order by` from `?sort=&order=`, restricted to a whitelist of SQL expressions
 * (never user text in SQL). Nulls always sort last, like the mock `sortBy`.
 */
export function orderBy(
  q: Q,
  query: URLSearchParams,
  columns: Record<string, string>,
  fallback: { key: string; order: "asc" | "desc" },
  tieBreaker?: string,
): postgres.Fragment {
  const key = query.get("sort") ?? fallback.key;
  const expr = columns[key] ?? columns[fallback.key];
  const order = (query.get("order") ?? fallback.order) === "asc" ? "asc" : "desc";
  return q.unsafe(`order by ${expr} ${order} nulls last${tieBreaker ? `, ${tieBreaker}` : ""}`);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(n, min), max);
}

/**
 * Laravel-style page over a counted result: `fetch(limit, offset)` loads one
 * page. The page number is clamped to the last page, like the mock paginator.
 */
export async function paged<T>(
  query: URLSearchParams,
  total: number,
  defaultPerPage: number,
  fetch: (limit: number, offset: number) => Promise<T[]>,
): Promise<{ items: T[]; pagination: Pagination }> {
  const perPage = clampInt(query.get("per_page"), defaultPerPage, 1, 100);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const page = clampInt(query.get("page"), 1, 1, lastPage);
  const offset = (page - 1) * perPage;
  const items = total === 0 ? [] : await fetch(perPage, offset);
  return {
    items,
    pagination: {
      current_page: page,
      per_page: perPage,
      total,
      last_page: lastPage,
      from: total === 0 ? 0 : offset + 1,
      to: offset + items.length,
      has_next: page < lastPage,
    },
  };
}

/** `[{ k, n }]` rows from a `group by` → `{ key: count, …, all }` (missing keys are 0). */
export function countsOf<K extends string>(rows: readonly { k: string | null; n: number }[], keys: readonly K[]) {
  const counts = Object.fromEntries([...keys, "all"].map((k) => [k, 0])) as Record<K | "all", number>;
  for (const { k, n } of rows) {
    if (k !== null && k in counts) counts[k as K] += n;
    counts.all += n;
  }
  return counts;
}

/** Start and end (exclusive) of the server-local calendar day containing `d`, as ISO strings. */
export function dayBounds(d: Date): [string, string] {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

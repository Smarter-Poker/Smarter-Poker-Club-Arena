/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PAGINATED SELECT — the fix for silent PostgREST truncation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-20. PostgREST applies `db-max-rows` (1,000 on this project) to EVERY
 * select. It does not error, it does not warn: it returns the first page and
 * the caller sees a short array that looks complete.
 *
 * That is not a theoretical risk. HorseFleetManager.seedAllTables read
 *
 *     supabase.from('table_seats').select('user_id, table_id, seat_number')
 *             .is('left_at', null)
 *
 * to work out which seats are occupied. There are 1,428 open seats (1,245 of
 * them on tournament tables), so 428 of them were invisible — and every seat
 * the seeder could not see, it believed was EMPTY and tried to sit a horse in.
 * Measured in postgres_logs: 18,744 `duplicate key value violates unique
 * constraint "table_seats_table_id_seat_number_key"` in three hours, ~150,000 a
 * day, the single largest error stream on the platform. The same truncated map
 * fed the per-horse 4-table cap and the "is a human short-handed here?" rescue
 * check, so both of those were wrong too.
 *
 * No money was ever at risk — atomic_table_buyin is the authoritative guard and
 * it rejected every one of them, which is exactly why this was invisible for so
 * long: the failure mode was pure waste, and the waste was logged at a level
 * nobody watches.
 *
 * Use this whenever a query MUST be complete to be correct. It pages with an
 * explicit ORDER BY (OFFSET without a total order can skip or repeat rows) and
 * reports rather than silently truncating if it hits the ceiling.
 */

import { reportError } from '../errorReporter.js';

/** PostgREST refuses to return more than db-max-rows in one response. */
export const POSTGREST_PAGE = 1000;

export interface FetchAllOptions {
  /** Identifies the call site in the alarm if the ceiling is hit. */
  label: string;
  /** Rows per request. Never useful above POSTGREST_PAGE — the server caps it. */
  pageSize?: number;
  /**
   * Hard ceiling. Reaching it is reported, because a query that legitimately
   * returns this much is a query that should have been an aggregate.
   */
  maxRows?: number;
}

/**
 * Run a PostgREST select to completion.
 *
 * @param makeQuery must return a FRESH builder each call (builders are
 *        single-use) and must impose a total order, or paging is undefined.
 */
export async function fetchAllRows<T>(
  makeQuery: () => {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
  },
  opts: FetchAllOptions
): Promise<T[]> {
  const pageSize = Math.min(opts.pageSize ?? POSTGREST_PAGE, POSTGREST_PAGE);
  const maxRows = opts.maxRows ?? 100_000;
  const out: T[] = [];

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await makeQuery().range(offset, offset + pageSize - 1);
    if (error) {
      reportError(error, `${opts.label}.page_failed`);
      // A partial result is worse than none for a caller that needs
      // completeness — say so by returning what we have AND alarming.
      return out;
    }
    const rows = data ?? [];
    out.push(...rows);
    // A short page is the end of the data. A full page might be, but we cannot
    // know without asking again — so we ask.
    if (rows.length < pageSize) return out;
  }

  reportError(
    new Error(
      `[${opts.label}] hit the ${maxRows}-row ceiling and may be truncated. ` +
        `A result this large should be an aggregate, not a full read.`
    ),
    `${opts.label}.row_ceiling`
  );
  return out;
}

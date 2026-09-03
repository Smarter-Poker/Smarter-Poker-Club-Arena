/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PAGINATED SELECT — the fix for silent PostgREST truncation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PostgREST applies `db-max-rows` (1,000 on this project) to EVERY select. It
 * does not error and it does not warn: it returns the first page and the caller
 * sees a short array that looks complete.
 *
 * That is not a theoretical risk. HorseFleetManager.seedAllTables read
 *
 *     supabase.from('table_seats').select('user_id, table_id, seat_number')
 *             .is('left_at', null)
 *
 * to work out which seats are occupied. There are 1,428 open seats (1,245 of
 * them on tournament tables), so 428 of them were invisible — and every seat the
 * seeder could not see, it believed was EMPTY and tried to sit a horse in.
 * Measured in postgres_logs: 18,744 `duplicate key value violates unique
 * constraint "table_seats_table_id_seat_number_key"` in three hours, ~150,000 a
 * day, the single largest error stream on the platform.
 *
 * ── KEYSET, NOT OFFSET (review fix 2026-08-20) ───────────────────────────────
 *
 * The first version paged with `.range(from, to)` and claimed that a total
 * ORDER BY made that safe. It does not. A total order fixes WITHIN-page
 * nondeterminism; it does nothing about the result set shifting BETWEEN pages,
 * because every page is a separate request under a separate snapshot.
 *
 * Concretely, on the exact query above: pages are `0-999` and `1000-1427`. If
 * one player leaves between the two requests, `left_at` is set, that row drops
 * out of the filter, every later row shifts down one index, and `OFFSET 1000`
 * now starts PAST the row that was at index 1000. That seat is never returned —
 * so the seeder tries to sit a horse in it, producing the very duplicate-key
 * error this module exists to eliminate, at a lower rate instead of zero. Seats
 * leave constantly in a live room.
 *
 * Keyset paging (`WHERE id > :cursor ORDER BY id`) has no such window: a row
 * deleted before the cursor cannot shift anything after it, and a row inserted
 * before the cursor cannot be returned twice.
 *
 * ── COMPLETENESS IS PART OF THE CONTRACT (review fix 2026-08-20) ─────────────
 *
 * The first version returned a bare `T[]` on error — a short array
 * indistinguishable from a complete one, behind a Sentry event nobody blocks
 * on. That re-armed the original failure mode. It now returns
 * `{ rows, complete }`, so a caller that needs completeness has to look, and
 * TypeScript makes them.
 */

import { reportError } from '../errorReporter.js';

/** PostgREST refuses to return more than db-max-rows in one response. */
export const POSTGREST_PAGE = 1000;

/**
 * A TRANSIENT TIMEOUT IS NOT AN ANSWER (2026-09-02).
 *
 * Every caller of this module is written to fail CLOSED on `complete: false` -
 * correctly, because acting on half a read is the truncation bug this module
 * exists to eliminate. But that made a single dropped packet expensive out of
 * all proportion: one `supabase_timeout` on page one and the caller abandons
 * its entire cycle.
 *
 * Measured on the live engine, 2026-09-02:
 *
 *   [TournamentRecurring.registerHorses.page_failed] Error: supabase_timeout
 *   [TournamentRecurring] registerHorses skipped: fleet read incomplete
 *
 * That is a whole tournament-filling pass thrown away because one HTTP request
 * to read a 1,000-row fleet timed out.
 *
 * A page read is IDEMPOTENT - same cursor, same filter, no side effects - so
 * re-asking is free of the hazard that makes retrying a WRITE dangerous
 * (CLAUDE.md 11.5). Retry it. Fail closed only when the database genuinely
 * will not answer.
 *
 * Three attempts with a short backoff, deliberately: this runs inside the
 * 5-second discovery tick, so the total added latency on a doomed read is
 * bounded at PAGE_RETRY_BACKOFF_MS summed - 600ms - rather than allowed to
 * grow with a longer schedule.
 */
export const PAGE_ATTEMPTS = 3;
export const PAGE_RETRY_BACKOFF_MS = [200, 400] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The subset of the PostgREST builder this module drives. */
export type PageQuery<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

export interface FetchAllOptions {
  /** Identifies the call site in the alarm if a page fails or the cap is hit. */
  label: string;
  /** Rows per request. Never useful above POSTGREST_PAGE — the server caps it. */
  pageSize?: number;
  /**
   * Hard ceiling. Reaching it is reported, because a query that legitimately
   * returns this much is a query that should have been an aggregate.
   */
  maxRows?: number;
  /** Column carrying the keyset cursor. Must be unique and orderable. */
  idKey?: string;
  /**
   * Attempts per page before the read is declared incomplete. 1 disables the
   * retry entirely. See PAGE_ATTEMPTS for why the default is not 1.
   */
  pageAttempts?: number;
}

export interface FetchAllResult<T> {
  rows: T[];
  /**
   * False when a page failed or the row ceiling was hit — `rows` is a PARTIAL
   * result. Any caller whose logic assumes it saw everything must bail out.
   */
  complete: boolean;
}

/**
 * Run a PostgREST select to completion by keyset.
 *
 * @param makeQuery must return a FRESH builder each call (builders are
 *        single-use). It receives the last id of the previous page, or null for
 *        the first page, and must apply `.gt(idKey, cursor)` when it is not
 *        null, plus `.order(idKey, { ascending: true })` and `.limit(pageSize)`.
 */
export async function fetchAllRows<T extends Record<string, unknown>>(
  makeQuery: (cursor: string | null, pageSize: number) => PageQuery<T>,
  opts: FetchAllOptions
): Promise<FetchAllResult<T>> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? POSTGREST_PAGE, POSTGREST_PAGE));
  const maxRows = opts.maxRows ?? 100_000;
  const idKey = opts.idKey ?? 'id';
  const attempts = Math.max(1, opts.pageAttempts ?? PAGE_ATTEMPTS);
  const out: T[] = [];
  let cursor: string | null = null;

  while (out.length < maxRows) {
    // Never ask for more than the ceiling allows, so maxRows is exact rather
    // than "the next multiple of pageSize above it".
    const want = Math.min(pageSize, maxRows - out.length);

    /* Re-ask on failure rather than abandoning the read. `makeQuery` is
       documented to return a FRESH builder each call, and the cursor is
       unchanged, so every attempt is the identical request. */
    let data: T[] | null = null;
    let error: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      ({ data, error } = await makeQuery(cursor, want));
      if (!error) break;
      if (attempt < attempts) {
        await sleep(
          PAGE_RETRY_BACKOFF_MS[attempt - 1] ??
            PAGE_RETRY_BACKOFF_MS[PAGE_RETRY_BACKOFF_MS.length - 1]
        );
      }
    }

    if (error) {
      // Only the FINAL failure is reported. Alarming on each attempt would
      // turn one flaky page into three alarms and bury the real signal.
      reportError(error, `${opts.label}.page_failed`);
      return { rows: out, complete: false };
    }

    const rows = data ?? [];
    out.push(...rows);

    // A short page is the end of the data. A full page might be, but we cannot
    // know without asking again — so we ask.
    if (rows.length < want) return { rows: out, complete: true };

    const last = rows[rows.length - 1]?.[idKey];
    if (last === undefined || last === null) {
      reportError(
        new Error(
          `[${opts.label}] row is missing the keyset column "${idKey}" - the select must ` +
            `include it or paging cannot advance. Returning a partial result.`
        ),
        `${opts.label}.missing_cursor_key`
      );
      return { rows: out, complete: false };
    }
    cursor = String(last);
  }

  reportError(
    new Error(
      `[${opts.label}] hit the ${maxRows}-row ceiling and is truncated. ` +
        `A result this large should be an aggregate, not a full read.`
    ),
    `${opts.label}.row_ceiling`
  );
  return { rows: out, complete: false };
}

/**
 * THE SETTLER READS ONLY WHAT EVERY WRITER HAS COMMITTED (2026-09-27)
 *
 * Deliberately import-free, like cashAccountingBatchBudget.ts: the rule is a
 * shape check, and its test must not half-initialise a Supabase client.
 *
 * rake_records.created_at is its writer's TRANSACTION START (column default
 * now()), not its commit. RakebackSettlerService pages the table by the keyset
 * (created_at, id) and saves the last row it read as a durable cursor. A hand
 * whose transaction starts at T and commits at T+6s is invisible to a page
 * read in between, which can read later-started, already-committed rows and
 * move the cursor past T. When the hand commits, its row is below the cursor
 * and no later page reaches it: its rakeback and commissions are never
 * accrued, and the union's certified weekly plan refuses the week
 * (union_cash_sources_do_not_match_bank). Fifty-one such rows were stranded
 * between 2026-09-26 13:38 and 2026-09-27 13:18, in every club, one of them
 * proved by a lock wait in postgres_logs that ended six seconds after its
 * created_at.
 *
 * public.fn_rakeback_settler_read_horizon() (migration 20260927144455) answers
 * LEAST(now(), the start of the oldest transaction still open in this
 * database) minus a 60 second margin. A row stamped below it belongs to a
 * transaction that has already finished, so it is visible now or will never
 * exist. The settler reads created_at < horizon and its cursor can never pass
 * a row that is still in flight.
 */

export const SETTLER_READ_HORIZON_RPC = 'fn_rakeback_settler_read_horizon';

/**
 * The horizon exactly as the database rendered it (microseconds intact), or a
 * thrown error. There is no fallback: without a horizon the only safe read is
 * no read, and the caller holds its cursor.
 */
export function readSettlerHorizon(data: unknown): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Settler read horizon missing');
  }
  const record = data as Record<string, unknown>;
  const horizon = record.horizon;
  if (horizon === null || horizon === undefined) {
    const reason = typeof record.reason === 'string' ? record.reason : 'no_horizon';
    throw new Error(`Settler read horizon withheld: ${reason}`);
  }
  if (typeof horizon !== 'string' || horizon.trim() === '') {
    throw new Error('Settler read horizon is not a timestamp');
  }
  // It is interpolated into a PostgREST filter; a timestamptz never contains
  // these characters, so one that does is not a timestamp.
  if (/["',()]/.test(horizon) || Number.isNaN(Date.parse(horizon))) {
    throw new Error('Settler read horizon is not a timestamp');
  }
  return horizon;
}

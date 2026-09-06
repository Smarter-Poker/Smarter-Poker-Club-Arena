/**
 * A FINISH THAT DEADLOCKS IS RETRIED (2026-09-06).
 *
 * The COMPLETING -> COMPLETED update at the end of finishTournament fires
 * fn_clear_seats_on_game_end, which closes every seat of the event, while a
 * table engine may still be cashing one of those seats out. Postgres picks a
 * victim in milliseconds and the survivor commits; the victim's statement,
 * re-issued a moment later, succeeds. Five events in one hour on 2026-09-06
 * were left in COMPLETING - paid, rake settled, status wrong - because the
 * first attempt was the only attempt.
 *
 * Pure so the classification is pinned without a database.
 */

export const COMPLETED_FLIP_ATTEMPTS = 3;
export const COMPLETED_FLIP_BACKOFF_MS = 250;

/** 40P01 deadlock_detected, 55P03 lock_not_available, 40001 serialization:
 *  all resolve by waiting a moment. Anything else is a real refusal. */
const TRANSIENT_SQLSTATES = new Set(['40P01', '55P03', '40001']);

export function isTransientFlipError(
  err: { code?: string | null; message?: string | null } | null | undefined
): boolean {
  if (!err) return false;
  if (err.code && TRANSIENT_SQLSTATES.has(String(err.code))) return true;
  const msg = String(err.message ?? '').toLowerCase();
  return msg.includes('deadlock detected') || msg.includes('lock timeout');
}

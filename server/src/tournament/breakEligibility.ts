import { isUnlimitedMtt, type TournamentEntryCapacitySubject } from './tournamentEntryCapacity.js';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BREAK ELIGIBILITY — which formats may ever take the platform :55 break
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A THREE-HANDED HYPER MUST NEVER BREAK (2026-08-27, binding).
 *
 * The :55 synchronized break is a five-minute stop plus up to two minutes of
 * last-hand grace. Every Spin level is three minutes or less and the whole game
 * is over inside ten, so a Spin that takes the break spends most of its life
 * behind a full-screen overlay — and the two guards that stop a level advancing
 * during a break then hold the clock for the duration too. Measured 2026-08-28:
 * 68 Spins carried `break_started_at` stamped inside the :55 window over two
 * days, several of them stopped before finishing level 1.
 *
 * The gate used to live entirely in the CALLER (`GameServer` checked
 * `isMttOrXmtt() && synchronizedBreaksEnabled()` before pausing anything), and
 * `tournaments.synchronized_breaks` defaults to `true` — all 28,788 Spin rows
 * on the platform carry `true`. A caller-side gate plus a column that says the
 * wrong thing is one forgotten `&&` away from breaking a hyper, and that is
 * exactly what the production data shows happened.
 *
 * So the rule is stated ONCE, here, as a pure predicate with only pure imports (same
 * reasoning as payoutStructure.ts and startRules.ts: it feeds a lifecycle
 * branch inside TournamentManagerBase and must be unit-testable without
 * booting supabase). `pauseForBreak` itself now refuses, so no caller can get
 * it wrong, and migration
 * `20260827_spin_never_breaks_and_drawn_button_survives_restart` (applied
 * 2026-08-28) adds the `tournaments_short_formats_never_break` trigger, which
 * FORCES the column to `false` on every insert or update of a short format
 * whatever the writer intended. Its backfill left ~28.7k historical rows
 * alone — pre-existing NOT VALID check constraints refused the update — but
 * every one of those is COMPLETED or CANCELLED, so no row that can still deal
 * a hand carries `true`. This predicate is what covers them anyway.
 */

/**
 * Formats that are structurally too short to survive a five-minute stop.
 *
 * Read from BOTH `tournament_type` and `variant` because the two disagree in
 * the wild — the recurring service writes `tournament_type = 'SPIN'` and
 * `variant = 'spin'`, but scheduler-spawned rows have carried one without the
 * other. Either is sufficient evidence.
 */
export function isShortFormat(tournamentType: unknown, variant: unknown, satelliteTargetId?: unknown): boolean {
  if (isUnlimitedMtt({ tournament_type: tournamentType, variant, satellite_target_id: satelliteTargetId })) return false;
  const type = String(tournamentType ?? '').toUpperCase();
  const v = String(variant ?? '').toLowerCase();
  return type === 'SPIN' || type === 'SNG' || v === 'spin' || v === 'sng';
}

/**
 * May this tournament ever be paused for the platform-wide :55 break?
 *
 * Two independent reasons to say no, and the FORMAT one wins over the column:
 *
 *   1. a Spin or SNG is too short to break, whatever the row says;
 *   2. `synchronized_breaks = false` (2026-08-22 parity) — the tournament
 *      opted out of the platform break and keeps dealing through it.
 *
 * A row we could not read at all (`null`) is treated as an ordinary MTT, which
 * is the pre-existing default and the only safe direction for a format we
 * cannot identify: an MTT that misses a break loses nothing but synchrony,
 * while a Spin that takes one loses the game.
 */
export function mayTakeSynchronizedBreak(
  row:
    | (TournamentEntryCapacitySubject & {
        tournament_type?: unknown;
        variant?: unknown;
        synchronized_breaks?: unknown;
      })
    | null
    | undefined
): boolean {
  if (row && isUnlimitedMtt(row)) return row.synchronized_breaks !== false;
  if (isShortFormat(row?.tournament_type, row?.variant)) return false;
  return row?.synchronized_breaks !== false;
}

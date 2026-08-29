/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ELIMINATION SWEEP LOCK (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isProcessingEliminations` is a re-entrancy lock around the 5-second sweep,
 * and it was taken with no bound on how long it could be held. The `finally`
 * that releases it is not the guarantee it looks like: `finally` runs when the
 * try block SETTLES, and an await that never settles never settles. One
 * PostgREST request that hangs rather than erroring — a dead socket the
 * runtime has not noticed, a gateway holding the connection open — therefore
 * takes the lock permanently.
 *
 * What that costs is not a slow tournament, it is a dead one. Every later tick
 * returns at the first line, so nobody is eliminated, `remainingCount` never
 * falls to 1, `finishTournament` is unreachable, and the whole field's prize
 * money is stranded — the champion's included. It is the same outcome as the
 * 2026-08-28 ladder deadlock (Union PKO Afternoon 4f42d847) reached by a
 * different road, and it is equally silent: 4f42d847 sat for over an hour and
 * was found by a player rather than by us.
 *
 * This module is deliberately IMPORT-FREE so the decision can be tested
 * exactly, in the manner of payoutMath.ts, instead of scanned for with a regex
 * over the caller.
 */

/**
 * How long a sweep may hold the lock before we say so out loud. Twelve ticks.
 * A healthy sweep on the biggest field on the platform (a 355-entrant freeroll
 * across 40 tables) finishes inside one; a minute of silence is already a
 * fault, not slowness.
 */
export const ELIMINATION_SWEEP_STUCK_MS = 60_000;

/**
 * How long before the lock is taken away from it.
 *
 * Five minutes, and the asymmetry with the alert threshold is deliberate:
 * complaining is free, forcing is not. A sweep that is merely slow gets four
 * more minutes to finish on its own and nothing is forced.
 *
 * Forcing carries a real risk — the superseded sweep could in principle wake
 * up and write a finishing place that has since been handed to somebody else —
 * and it is taken for the same reason the 2026-08-28 ladder fix takes it: one
 * mislabelled place is a bookkeeping error a human can renumber, while
 * refusing to eliminate anybody strands the entire field's money. The
 * generation check in the caller narrows even that, by standing a resurrected
 * sweep down before its first write.
 */
export const ELIMINATION_SWEEP_FORCE_RELEASE_MS = 300_000;

/**
 * The whole decision the watchdog makes. Reading a held lock has exactly three
 * answers:
 *
 *   'wait'  — a sweep is running and has not been running long. Normal; this
 *             is most ticks of a busy tournament.
 *   'warn'  — it has been running long enough that something is wrong. Say so,
 *             once, and keep waiting.
 *   'force' — long enough that waiting is the worse option. Take the lock.
 *
 * `heldForMs` is measured from when the lock was taken. A non-finite or
 * negative value (a clock that moved, a start time that was never stamped) is
 * treated as 'wait': it is not evidence of a stall, and forcing on no evidence
 * is how you get two live sweeps for free.
 */
export function eliminationLockVerdict(heldForMs: number): 'wait' | 'warn' | 'force' {
  if (!Number.isFinite(heldForMs) || heldForMs < 0) return 'wait';
  if (heldForMs >= ELIMINATION_SWEEP_FORCE_RELEASE_MS) return 'force';
  if (heldForMs >= ELIMINATION_SWEEP_STUCK_MS) return 'warn';
  return 'wait';
}

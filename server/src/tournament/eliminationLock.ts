/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ELIMINATION SWEEP LOCK (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isProcessingEliminations` is a re-entrancy lock around the tournament sweep,
 * and it was taken with no bound on how long it could be held. The `finally`
 * that releases it is not the guarantee it looks like: `finally` runs when the
 * try block SETTLES, and an await that never settles never settles. One
 * PostgREST request that hangs rather than erroring — a dead socket the
 * runtime has not noticed, a gateway holding the connection open — therefore
 * takes the lock permanently. The process-wide scheduler bounds admission;
 * this lock still protects one tournament from a resurrected request.
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
 * How long a sweep may hold the lock before we say so out loud.
 * A healthy sweep on the biggest field on the platform (a 355-entrant freeroll
 * across 40 tables) finishes inside one; a minute of silence is already a
 * fault, not slowness.
 */
export const ELIMINATION_SWEEP_STUCK_MS = 60_000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEVEL NOTHING WAS PLAYED IN WAS NEVER SPENT (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately import-free, for the same reason as engineStartBudget.ts and
 * tournamentResumeBudget.ts: the law is arithmetic, and its test must not have
 * to half-initialise a database client to run.
 *
 * THE INCIDENT
 * On 2026-09-18/19 a fleet-wide lease-loss wave left ~470 tournaments frozen
 * in RUNNING with an F06 hand permit reserved under a generation that had died
 * mid-hand. No table of those events could deal for four days.
 *
 * THE BLIND CLOCK KEPT RUNNING ANYWAY. `resume()` arms the level timer from
 * the persisted `tournaments.level_started_at`, and its rule was written down
 * as "a persisted overdue level stays due, including after a long outage":
 *
 *     const elapsed = Date.now() - levelStartedAt - pausedMs;
 *     remainingMs = Math.max(1000, durationMs - elapsed);
 *
 * After four frozen days `elapsed` is four days, so `remainingMs` floors at
 * one second and the level is due the instant the manager arms it. Measured
 * medians of level 182 on frozen Spins and 1,348 on one of them; and on
 * 2026-09-22 at 13:24 UTC twenty-two recovered multi-table events resumed and
 * escalated straight past the end of their own structures -
 * `Auto-escalated blinds (level 45, structure has 40): 5000000/10000000 ante
 * 4000000` on a $100 Freeroll whose players held 3,000-15,000 chips. Every
 * player was all-in on every hand before a card was read. The recovery
 * destroyed the events it recovered.
 *
 * THE LAW
 * A blind level is a deadline a PLAYER loses to, and a player who could not be
 * dealt a hand did not get to lose to it. `advanceBlindLevel` already holds a
 * level that comes due during a break, inside the maintenance freeze, or with
 * no hand dealt since it began (A_LEVEL_IS_NOT_SPENT_ON_A_HAND_THAT_WAS_NEVER
 * _DEALT, 2026-09-23). This is the same rule at the other end of the outage -
 * the moment the clock is REARMED - because the hold above cannot undo a
 * remainder that resume() has already floored to one second.
 *
 * So the credit a resumed level gets is measured against DEALING, not against
 * the wall clock:
 *
 *   - the event dealt within the last whole level  ->  an ordinary restart.
 *     Credit the elapsed time exactly as before (TOURNEY-AUDIT 2026-07-24:
 *     granting a fresh full level on every restart nearly froze escalation
 *     across a restart-heavy window, and that fix is preserved untouched).
 *
 *   - the event has dealt NOTHING for at least a whole level  ->  an outage.
 *     The level's elapsed wall time was demonstrably not spent on play, so
 *     none of it is credited: the event resumes at the level play stopped at,
 *     with a fresh full level, and never fast-forwards.
 *
 * The evidence is a row the engine already owns - the event's most recent
 * dealt hand, read once per adoption through
 * idx_hand_history_tournament_created - not a wall-clock timer that keeps
 * perfect time through a freeze.
 *
 * WHY THE OUTAGE BRANCH GRANTS A FULL LEVEL RATHER THAN THE REMAINDER PLAY
 * STOPPED WITH. Both are defensible and the difference is at most one level's
 * length, but only one of them is safe in the direction this incident failed.
 * A field returning after hours or days away does not owe the forty seconds
 * that happened to be left on a clock nobody was watching, and handing it a
 * level that expires immediately is how a recovery turns back into an
 * escalation. A full level is the slower answer, and the slower answer is the
 * one that cannot destroy an event.
 */

/**
 * An idle gap this long is an outage rather than a lull, whatever the level
 * length. A healthy heads-up table deals an orbit in about two minutes and a
 * full one deals continuously, so no dealing event is quiet for five minutes;
 * a Spin's three-minute level would otherwise make an ordinary slow hand look
 * like a freeze. The cost of judging wrongly here is one level's worth of
 * slower blinds on a restart, and the cost of judging wrongly the other way
 * is the 2026-09-22 shape, so the threshold leans long on purpose.
 */
export const LEVEL_OUTAGE_FLOOR_MS = 5 * 60_000;

export interface LevelResumeReading {
  /** `tournaments.level_started_at`, epoch ms. */
  levelStartedAtMs: number;
  /** The event's most recent dealt hand, epoch ms; null when it never dealt. */
  lastDealtAtMs: number | null;
  nowMs: number;
  /** This level's full length, already format-normalised and accelerated. */
  durationMs: number;
  /** Break time this level already excluded (the caller's existing overlap). */
  pausedMs: number;
}

/**
 * True when the event has dealt nothing for at least a whole level, so this
 * level's elapsed wall time cannot have been spent on play.
 *
 * An event that has never dealt is measured from the level's own start: a
 * tournament that launched into a wedged table is the same shape as one that
 * froze in the middle, and it must not escalate on the strength of a clock
 * either.
 */
export function levelResumeIsAfterAnOutage(reading: LevelResumeReading): boolean {
  const { levelStartedAtMs, lastDealtAtMs, nowMs, durationMs, pausedMs } = reading;
  if (!Number.isFinite(levelStartedAtMs) || !Number.isFinite(nowMs)) return false;
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const dealt = lastDealtAtMs !== null && Number.isFinite(lastDealtAtMs) ? lastDealtAtMs : 0;
  // The later of "this level began" and "this event last dealt": time before
  // either of those is not this level's to account for.
  const idleSince = Math.max(levelStartedAtMs, dealt);
  // A BREAK IS NOT AN OUTAGE. The caller already measures the overlap of this
  // level and a recorded break, and an event behind a break overlay is not
  // dealing BY DESIGN - nobody lost anything to the clock and nothing is
  // wrong. Counting it as idle would hand a fresh full level to every
  // tournament that restarted during the :55, which is the 2026-07-24 defect
  // this law must not reintroduce: measured on the CA-03-09 restart fixture,
  // a 10-minute level with 30 s left across a 2-minute break read as a
  // 690,000 ms gap and would have been credited a whole new level.
  const paused = Number.isFinite(pausedMs) && pausedMs > 0 ? pausedMs : 0;
  const idleMs = nowMs - idleSince - paused;
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false;
  return idleMs >= Math.max(duration, LEVEL_OUTAGE_FLOOR_MS);
}

/**
 * The remaining time a resumed level is armed with, or `undefined` for a fresh
 * full level. `undefined` is exactly what `startBlindTimer`'s
 * `remainingOverrideMs` already means, so the caller's existing shape is kept.
 */
export function levelResumeRemainingMs(reading: LevelResumeReading): number | undefined {
  const { levelStartedAtMs, nowMs, durationMs, pausedMs } = reading;
  if (!Number.isFinite(levelStartedAtMs)) return undefined;
  // An outage credits nothing: the level play stopped at starts again, whole.
  if (levelResumeIsAfterAnOutage(reading)) return undefined;
  const paused = Number.isFinite(pausedMs) && pausedMs > 0 ? pausedMs : 0;
  const elapsed = nowMs - levelStartedAtMs - paused;
  // Unchanged from TOURNEY-AUDIT 2026-07-24: an ordinary restart resumes the
  // level mid-flight, and a persisted overdue level inside a dealing event
  // still stays due.
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return Math.max(1000, duration - elapsed);
}

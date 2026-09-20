/**
 * WHEN IS A SET OF ZOMBIE VERDICTS ONE FAULT RATHER THAN MANY?
 *
 * The control law lives here, pure and tested here, in the same shape as
 * engineStartBudget.ts. GameServer's zombie sweep calls it once per pass with
 * the verdicts it has collected and the population it collected them from.
 *
 * MEASURED OVER SEVEN DAYS, from `engine_recovery_events`, by MINUTE OF THE
 * HOUR. Zombie kills only:
 *
 *   minute :03   30,372 kills, in 45 separate hours, 6,618 tables
 *   minute :04   12,207 kills, in 12 separate hours, 3,530 tables
 *   :13             392        :55  260        :56  239
 *   every other minute of the hour: under 250
 *
 * 97% of every zombie kill on this platform landed in two minutes of the
 * hour. On 2026-09-18 at 03:03 that was 464 tables condemned inside one
 * minute, out of a fleet of about 500, and 249 more at 03:13.
 *
 * The arithmetic is self-inflicted: the maintenance break parks every table at
 * :55, the break runs five minutes, and the sweep condemns at 180 seconds of
 * no progress. Every parked table crosses the line together, so the pass that
 * closes the break window rebuilds the whole estate.
 *
 * A third, not a half. A third of a live fleet failing INDEPENDENTLY inside
 * the same three-minute window is not a thing that happens. The floor keeps
 * small and test fleets on the ordinary per-table path, where a genuine
 * one-of-three is exactly what the sweep is for.
 */
export const FLEET_WIDE_ZOMBIE_SHARE_DIVISOR = 3;
export const FLEET_WIDE_ZOMBIE_FLOOR = 8;

/**
 * True when this pass's verdicts describe one systemic pause rather than a
 * set of independently broken tables, and the sweep must therefore stand down.
 *
 * Standing down removes NO recovery. Each table keeps its own watchdog, which
 * is per-table and independent of this sweep; and if the fleet is genuinely
 * dead rather than paused, the process-level liveness verdict still answers
 * for it, which is the one place a whole-fleet judgement belongs.
 */
export function isFleetWideStall(condemned: number, candidates: number): boolean {
  if (!Number.isFinite(condemned) || !Number.isFinite(candidates)) return false;
  if (condemned < FLEET_WIDE_ZOMBIE_FLOOR) return false;
  if (candidates <= 0) return false;
  return condemned * FLEET_WIDE_ZOMBIE_SHARE_DIVISOR > candidates;
}

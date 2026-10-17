/**
 * Test support for the declared-work law (2026-10-16,
 * docs/changelog/2026-10-16-packs-do-declared-work.md): a pack's live decision
 * must be the same whatever the clock reads. These helpers run one decision
 * under several clocks from the same random state and compare everything but
 * the measurements the clock feeds.
 */
import { restoreFastRandom, saveFastRandom } from './HorseEval.js';

/** Fields that only measure elapsed time; every other field must match. */
const MEASUREMENTS = new Set([
  'latencyMs',
  'analysisMs',
  'simulationMs',
  'policyMs',
  'utilityLatencyMs',
  // HorsePolicyGraph's per-node timing of a whole HorseLogic.decide.
  'elapsedMs',
]);

/** A JSON copy of `value` with every time measurement set to 0. */
export function withoutMeasurements(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => (MEASUREMENTS.has(key) && typeof v === 'number' ? 0 : v))
  );
}

/** A clock that advances `stepMs` on every read: a slow or loaded host. */
export function slowClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

/** A clock that reads 0 and then jumps far past any former budget. */
export function stalledClock(afterMs = 1_000): () => number {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return 0;
    }
    return afterMs;
  };
}

/**
 * Runs `decide` once per clock, each from the same global random state, and
 * returns the results with their measurements removed. The random state after
 * the call is the one the last run left.
 */
export function decideUnderClocks<T>(
  decide: (now: () => number) => T,
  clocks: ReadonlyArray<() => number> = [() => 0, slowClock(5), stalledClock()]
): unknown[] {
  const rng = saveFastRandom();
  return clocks.map((clock) => {
    restoreFastRandom(rng);
    return withoutMeasurements(decide(clock));
  });
}

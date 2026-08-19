/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  serverClock — translate between this device's clock and the engine's
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY
 *
 * Dan, 2026-08-18: "make sure the yellow countdown actually takes 15 seconds."
 *
 * The engine was never wrong about the duration. Every table has
 * action_time_seconds = 15, and it publishes an absolute deadline
 * (turn_deadline_ms) computed from it. The client then worked out how much of
 * the turn had already elapsed as:
 *
 *     elapsedMs = Date.now() - turn_start_time_ms
 *
 * which subtracts a SERVER timestamp from a CLIENT one. Those are two different
 * clocks. A device running three seconds fast reports three seconds elapsed the
 * instant the turn begins, so the ring starts part-drained and empties in
 * twelve; a device running slow overruns. Phones drift, VMs suspend, and a
 * hand-set clock can be off by minutes.
 *
 * The DURATION was always safe, because `turn_deadline_ms - turn_start_time_ms`
 * subtracts two server timestamps and the offset cancels. Only the elapsed
 * calculation was cross-clock.
 *
 * HOW
 *
 * The engine now stamps every state broadcast with its own `server_time_ms`.
 * On arrival we compare it to the local clock; the difference is the offset,
 * plus a little network latency. That latency is small and always errs the safe
 * way for a countdown - we believe slightly MORE time has passed than really
 * has, so the ring never claims time the player does not have.
 *
 * The offset is smoothed rather than replaced outright, so one delayed packet
 * cannot jerk the ring, and it is only applied once a sample has been seen.
 * Before that, serverNow() is just Date.now() - exactly the old behaviour, and
 * correct for any device whose clock is right.
 */

/** Exponential smoothing factor for offset updates. 1 = trust each sample fully. */
const SMOOTHING = 0.3;

/** Ignore absurd samples (bad payload, or a clock caught mid-adjustment). */
const MAX_PLAUSIBLE_OFFSET_MS = 24 * 60 * 60 * 1000;

let offsetMs = 0;
let haveSample = false;

/**
 * Feed the `server_time_ms` from a state snapshot.
 * Safe to call on every snapshot: cheap, allocation-free, ignores junk.
 */
export function recordServerTime(serverTimeMs: number | undefined | null): void {
  if (typeof serverTimeMs !== 'number' || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0) {
    return;
  }
  const sample = Date.now() - serverTimeMs;
  if (Math.abs(sample) > MAX_PLAUSIBLE_OFFSET_MS) return;

  offsetMs = haveSample ? offsetMs + (sample - offsetMs) * SMOOTHING : sample;
  haveSample = true;
}

/** Current time on the ENGINE's clock, in epoch ms. */
export function serverNow(): number {
  return Date.now() - offsetMs;
}

/** How far this device's clock is ahead of the engine's, in ms. Positive = ahead. */
export function clockOffsetMs(): number {
  return haveSample ? offsetMs : 0;
}

/** Test seam. */
export function __resetServerClock(): void {
  offsetMs = 0;
  haveSample = false;
}

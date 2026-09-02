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
 * plus a little network latency.
 *
 * ── LATENCY SIGN CORRECTION 2026-08-28 ──
 *
 * This block used to claim that latency "always errs the safe way ... so the
 * ring never claims time the player does not have". The arithmetic does the
 * OPPOSITE, and on the action clock that is the expensive direction. Writing
 * it out, with L = one-way latency and D = the true offset (client ahead of
 * server):
 *
 *     sample      = Date.now() - server_time_ms = D + L
 *     serverNow() = Date.now() - offset         = trueServerNow - L
 *     remaining   = deadline - serverNow()      = trueRemaining + L
 *
 * So the countdown ran one latency BEHIND the engine and displayed time that
 * did not exist. A player acting on the last instant the ring showed them
 * could be folded by a deadline that had already passed.
 *
 * Every one-way sample overstates the offset by its own latency, so no amount
 * of smoothing removes it — averaging just bakes in the AVERAGE latency, and
 * jitter makes that worse than the best sample. The estimator now takes the
 * MINIMUM sample in a rolling window (Cristian's algorithm): the smallest
 * latency observed is the closest a one-way sample can get to the true offset.
 * That shrinks the residual from average-plus-jitter to one best-case
 * latency, and it is the tightest correction available without a round trip.
 *
 * The window resets so genuine clock drift is still tracked, and the value is
 * still smoothed toward the window minimum so one delayed packet cannot jerk
 * the ring. Before the first sample, serverNow() is just Date.now() - exactly
 * the old behaviour, and correct for any device whose clock is right.
 */

/** Exponential smoothing factor for offset updates. 1 = trust each sample fully. */
const SMOOTHING = 0.3;

/** Ignore absurd samples (bad payload, or a clock caught mid-adjustment). */
const MAX_PLAUSIBLE_OFFSET_MS = 24 * 60 * 60 * 1000;

/**
 * How long a minimum-sample window lasts. Long enough that a quiet stretch
 * still collects several samples, short enough that real clock drift (a phone
 * waking from sleep, an NTP correction) is picked up promptly.
 */
const WINDOW_MS = 60_000;

let offsetMs = 0;
let haveSample = false;
/** Smallest sample seen in the current window — the best offset estimate. */
let windowMinMs = 0;
let windowStartedAt = 0;

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

  const now = Date.now();
  if (!haveSample) {
    // First sample: adopt it outright, exactly as before. It carries this
    // packet's latency, and the window below walks that back as more arrive.
    windowMinMs = sample;
    windowStartedAt = now;
    offsetMs = sample;
    haveSample = true;
    return;
  }
  if (now - windowStartedAt >= WINDOW_MS) {
    // New window — re-seed from this sample so a drifting clock is tracked
    // rather than pinned to a minimum taken minutes ago.
    windowMinMs = sample;
    windowStartedAt = now;
  } else if (sample < windowMinMs) {
    windowMinMs = sample;
  }
  // Converge on the window's best (lowest-latency) sample, not on the raw
  // one — see the LATENCY SIGN CORRECTION note at the top of this file.
  offsetMs += (windowMinMs - offsetMs) * SMOOTHING;
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
  windowMinMs = 0;
  windowStartedAt = 0;
}

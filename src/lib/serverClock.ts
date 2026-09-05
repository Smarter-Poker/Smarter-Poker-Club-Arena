/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE'S CLOCK, AS THIS DEVICE LAST HEARD IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BBJ build plan phase 1 (2026-09-05).
 *
 * Every timing rule that compares an engine stamp against "now" used to read
 * `Date.now()` on the device. The jackpot freshness gate (lib/bbjHitOnce) is
 * the one where that bites: it refuses a hit older than ninety seconds as a
 * replay, and a phone whose clock runs two minutes fast makes EVERY live hit
 * look ninety-plus seconds old. The celebration never plays on that phone,
 * ever, and nothing anywhere records why. Clocks that far out are not exotic
 * - a phone with automatic time off, a tablet that missed a DST change.
 *
 * The engine already tells us its clock: every EVENT frame carries `ts`, the
 * engine's `Date.now()` at the moment the frame was sent (TableStateHub), and
 * the keepalive PING carries `ts` too. This module keeps the offset between
 * that clock and the device's, and `serverNow()` answers "what time is it on
 * the engine" without asking the device to be right.
 *
 * Latency is ignored on purpose: a frame is on the wire for tens of
 * milliseconds and the rules that consume this work in seconds. A skew of
 * minutes is the problem; a skew of milliseconds is noise.
 *
 * Until the first frame arrives the offset is zero and `serverNow()` is the
 * device clock - exactly the behaviour every caller had before this existed,
 * never worse.
 */

let offsetMs = 0;
let heardAt = 0;

/** Record an engine timestamp as it arrives. Non-numbers and zeros are ignored. */
export function noteServerTime(ts: unknown): void {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return;
  const now = Date.now();
  offsetMs = ts - now;
  heardAt = now;
}

/** The engine's clock, or the device clock if the engine has not spoken yet. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Engine minus device, in ms. Positive means the device runs behind the engine. */
export function serverClockOffsetMs(): number {
  return offsetMs;
}

/** When the engine was last heard from (device clock), 0 if never. */
export function serverClockHeardAt(): number {
  return heardAt;
}

/** Test-only reset. */
export function __resetServerClockForTests(): void {
  offsetMs = 0;
  heardAt = 0;
}

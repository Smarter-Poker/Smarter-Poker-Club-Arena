/**
 * A WARNING THAT GOES PERMANENTLY SILENT IS NOT A WARNING (2026-09-12).
 *
 * Every lease warning below was written as `if (xErrors <= 3)`. Those counters
 * only ever increment, so after the third occurrence in a process lifetime the
 * path is silent forever. The cap exists for a real reason - a failing
 * heartbeat can recur every five seconds and would drown the log - but "quiet"
 * and "silent" were collapsed into the same thing.
 *
 * It cost a night. On 2026-09-12 the ownership lease renewal loop stopped and
 * every cash table was killed by its own twenty second proof watchdog and
 * re-claimed, 26,129 times in 2h10m, with 1,483 hands abandoned mid-play. The
 * container log carried NOT ONE `[lease]` line across the whole run, so the
 * first read of it concluded the heartbeat was never being called. That
 * happened to be true, but the log could not have told the difference between
 * "never called" and "failing every five seconds since the third attempt".
 *
 * This keeps the flood protection and drops the permanence: the first three are
 * printed as before, and after that at most one a minute, carrying how many
 * were suppressed since the last one. A recurring failure is therefore always
 * visible within sixty seconds, and a burst still costs a handful of lines.
 */
const WARN_BURST = 3;
const WARN_QUIET_MS = 60_000;
const warnState = new Map<string, { seen: number; suppressed: number; lastAt: number }>();

export function _resetLeaseWarnThrottleForTests(): void {
  warnState.clear();
}

/** Returns the text to print, or null while inside the quiet window. */
export function throttledLeaseWarning(
  key: string,
  message: string,
  now: number = Date.now()
): string | null {
  const st = warnState.get(key) ?? { seen: 0, suppressed: 0, lastAt: -Infinity };
  st.seen += 1;
  if (st.seen <= WARN_BURST || now - st.lastAt >= WARN_QUIET_MS) {
    const held = st.suppressed;
    st.suppressed = 0;
    st.lastAt = now;
    warnState.set(key, st);
    return held > 0 ? `${message} (${held} more since the last of these)` : message;
  }
  st.suppressed += 1;
  warnState.set(key, st);
  return null;
}

/** Print `message` unless the throttle is holding it back. */
export function warnThrottled(key: string, message: string): void {
  const line = throttledLeaseWarning(key, message);
  if (line !== null) console.warn(line);
}

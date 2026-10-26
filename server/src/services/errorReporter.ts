/** Local engine diagnostics. Reporting never interrupts the caller's work. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    const e = error as Record<string, any>;
    const head = e.message || e.error_description || e.details || e.hint || e.error || null;
    const code = e.code ? ` (${e.code})` : '';
    if (head) return `${String(head)}${code}`;
    try {
      return `${JSON.stringify(error)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  try {
    if (extra === undefined) console.error(`[${context}]`, error);
    else console.error(`[${context}]`, error, extra);
  } catch {
    // A broken stderr pipe must not unwind an engine loop or its catch handler.
  }
}

/**
 * AN EXPECTED REFUSAL IS COUNTED, NOT STACK-TRACED (2026-10-25).
 *
 * `reportError` prints the error object, which for an Error is its stack:
 * eight lines per call. That is right for a failure nobody expected. It is
 * wrong for an admission outcome the code is designed to produce under load:
 * the opponent-memory read admission refuses with `opponent memory
 * unavailable: busy` whenever eight reads are already in flight, and on
 * 2026-10-25 it did so 17,921 times in ten minutes (measured on engine-01),
 * each with its stack - 115,311 stack lines, more than half of everything the
 * engine wrote. The refusal is already a number in the horse telemetry
 * (horse_opponent_memory_read_busy); the stack adds nothing and it is what
 * rotated the json-file window in under two hours, so the 13:27:10 UTC
 * storm's log was gone before anyone could read it.
 *
 * This reports an expected refusal as ONE line, once per window per context,
 * carrying how many were held since the last line. The first refusal of a
 * quiet window is printed at once, so a new episode is visible in the log
 * the moment it starts; a flood is visible as a count. Never a stack.
 */
const throttledWindows = new Map<string, { windowStartedAt: number; held: number }>();
export const THROTTLED_REPORT_WINDOW_MS = 60_000;

export function reportThrottled(
  context: string,
  message: string,
  windowMs: number = THROTTLED_REPORT_WINDOW_MS,
  now: number = Date.now()
): void {
  try {
    const key = `${context}|${message}`;
    const window = throttledWindows.get(key);
    if (window && now - window.windowStartedAt < windowMs) {
      window.held++;
      return;
    }
    const held = window?.held ?? 0;
    throttledWindows.set(key, { windowStartedAt: now, held: 0 });
    console.warn(
      held > 0
        ? `[${context}] ${message} (${held} more in the last ${Math.round(windowMs / 1000)}s)`
        : `[${context}] ${message}`
    );
  } catch {
    // A broken stderr pipe must not unwind an engine loop or its catch handler.
  }
}

/** Test seam: forget every window so a test starts from a quiet log. */
export function _resetThrottledReportsForTests(): void {
  throttledWindows.clear();
}

/** The admission refusal the opponent-memory readers are designed to produce under load. */
export function isOpponentMemoryBusyRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === 'opponent memory unavailable: busy';
}

export function reportWarning(message: string, context: string, data?: Record<string, any>): void {
  try {
    if (data === undefined) console.warn(`[${context}] ${message}`);
    else console.warn(`[${context}] ${message}`, data);
  } catch {
    // A broken stderr pipe must not replace the original result.
  }
}

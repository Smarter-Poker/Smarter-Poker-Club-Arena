/**
 * ASK THE ENGINE ONCE, AND WAIT FOR ITS ANSWER (2026-10-05).
 *
 * Used when an action's outcome is unknown: every send went unanswered, but
 * the first may have executed with its response lost. Before the page hands
 * the action bar back it asks the engine for its current state (the existing
 * RESYNC path, requestSnapshot) and waits for the next snapshot to land, so a
 * landed action is shown as landed rather than undone.
 *
 * Bounded and single-shot: one request, released by the next snapshot or by
 * the budget, whichever comes first. Never a retry, never a loop.
 */
export const ACTION_OUTCOME_STATE_BUDGET_MS = 2_500;

export function awaitEngineState(
  waiters: Set<() => void>,
  requestSnapshot: () => void,
  budgetMs: number = ACTION_OUTCOME_STATE_BUDGET_MS
): Promise<void> {
  return new Promise<void>((resolve) => {
    const release = () => {
      clearTimeout(timer);
      waiters.delete(release);
      resolve();
    };
    // Declared before anything can call release (the request runs below).
    const timer = setTimeout(release, budgetMs);
    waiters.add(release);
    try {
      requestSnapshot();
    } catch {
      release();
    }
  });
}

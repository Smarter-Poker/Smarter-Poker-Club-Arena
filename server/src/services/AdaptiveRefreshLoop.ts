export interface AdaptiveRefreshOutcome {
  ok: boolean;
}

interface AdaptiveRefreshLoopOptions<T extends AdaptiveRefreshOutcome> {
  load: () => Promise<T>;
  refreshMs: number;
  retryMs: number;
  maxRetryMs: number;
}

/**
 * Owns one non-overlapping refresh timer.
 *
 * Successful loads keep their slow normal cadence. A failed load switches the
 * same timer to bounded exponential retries until a complete load succeeds.
 * This is intentionally one interval rather than a chain of timeouts: callers
 * can stop it deterministically, and a slow request can never overlap itself.
 */
export function createAdaptiveRefreshLoop<T extends AdaptiveRefreshOutcome>({
  load,
  refreshMs,
  retryMs,
  maxRetryMs,
}: AdaptiveRefreshLoopOptions<T>): {
  runNow: () => Promise<T>;
  start: () => void;
  stop: () => void;
} {
  if (!Number.isFinite(refreshMs) || refreshMs <= 0) {
    throw new Error('adaptive_refresh_invalid_refresh_ms');
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0 || retryMs > refreshMs) {
    throw new Error('adaptive_refresh_invalid_retry_ms');
  }
  if (!Number.isFinite(maxRetryMs) || maxRetryMs < retryMs || maxRetryMs > refreshMs) {
    throw new Error('adaptive_refresh_invalid_max_retry_ms');
  }

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<T> | null = null;
  let lastSuccessfulAt: number | null = null;
  let retryRequired = false;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;

  const refreshIsDue = (): boolean => {
    const now = Date.now();
    if (now < nextAttemptAt) return false;
    return retryRequired || lastSuccessfulAt === null || now - lastSuccessfulAt >= refreshMs;
  };

  const markFailure = (): void => {
    retryRequired = true;
    consecutiveFailures += 1;
    const exponent = Math.min(consecutiveFailures - 1, 20);
    nextAttemptAt = Date.now() + Math.min(retryMs * 2 ** exponent, maxRetryMs);
  };

  const runNow = (): Promise<T> => {
    if (inFlight) return inFlight;

    const attempt: Promise<T> = Promise.resolve()
      .then(load)
      .then((outcome) => {
        if (outcome.ok) {
          lastSuccessfulAt = Date.now();
          retryRequired = false;
          consecutiveFailures = 0;
          nextAttemptAt = 0;
        } else {
          markFailure();
        }
        return outcome;
      })
      .catch((err) => {
        markFailure();
        throw err;
      })
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      if (!refreshIsDue() || inFlight) return;
      // Loaders report their own errors. This catch prevents a future loader
      // implementation from turning a timer callback into an unhandled reject.
      void runNow().catch(() => undefined);
    }, retryMs);
    timer.unref?.();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return { runNow, start, stop };
}

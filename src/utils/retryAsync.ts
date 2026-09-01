/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RETRY ASYNC — Exponential Backoff Retry Utility
 * ═══════════════════════════════════════════════════════════════════════════════
 * Wraps async functions with automatic retry on transient network errors.
 * Only retries on network/timeout failures — NOT on auth/validation errors.
 *
 * USE THIS for service-layer retries (non-React) where errors are thrown.
 * For component-level Supabase retries (detects `{ error }` in response),
 * use retryFetch.ts instead.
 */

/** Errors that are safe to retry (transient network issues) */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('fetch') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket') ||
      msg.includes('aborted') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('429')
    );
  }
  return false;
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - The async function to execute
 * @param maxRetries - Maximum number of retry attempts (default: 2)
 * @param baseDelayMs - Initial delay before first retry (default: 500ms)
 * @returns The result of the async function
 *
 * @example
 * const result = await retryAsync(() => supabase.from('tables').insert(data).select().maybeSingle());
 */
export async function retryAsync<T>(
  fn: () => PromiseLike<T> | Promise<T>,
  maxRetries: number = 2,
  baseDelayMs: number = 500,
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A CALLER HAS TO BE ABLE TO KNOW IT RETRIED (2026-09-01)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A retry is invisible to the caller today, and for a read that is fine.
   * For a WRITE it is not: a network error can be raised for a request the
   * server already COMMITTED, so the second attempt lands on top of work that
   * succeeded. The caller then sees "you already did that" and has no way to
   * tell whether that means "somebody else did it" or "you did it, a moment
   * ago, on the attempt you never saw succeed".
   *
   * The registration path is exactly that shape and it is a money path: a
   * blip after a committed buy-in returned `already_registered`, so the
   * player was told "Already registered for this tournament" having just been
   * charged for it.
   *
   * `onRetry` lets a write-path caller notice. It does not change any retry
   * behaviour and reads may ignore it entirely.
   */
  onRetry?: (attempt: number) => void
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry non-transient errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't wait after the last attempt
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[retryAsync] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        try {
          onRetry?.(attempt + 1);
        } catch {
          /* a caller's bookkeeping must never break the retry it is watching */
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

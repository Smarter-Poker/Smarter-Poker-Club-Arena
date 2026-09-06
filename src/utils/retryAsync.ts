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
  shouldRetry: (error: unknown) => boolean = isRetryableError
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry non-transient errors
      if (!shouldRetry(error)) {
        throw error;
      }

      // Don't wait after the last attempt
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[retryAsync] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

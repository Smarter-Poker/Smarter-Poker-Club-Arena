/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RETRY FETCH — Exponential backoff wrapper for Supabase queries
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps any async function with automatic retry on failure.
 * Uses exponential backoff: 1s → 2s → 4s (configurable).
 * Respects isMounted ref to avoid retrying after unmount.
 *
 * SUPABASE-AWARE: Supabase SDK returns `{ data, error }` instead of throwing.
 * This wrapper detects `{ error }` in the result and RETRIES the call, but
 * returns the final result (including error) after all retries are exhausted.
 * This preserves callers' `if (error) { ... }` graceful fallback patterns
 * while ensuring transient errors get retried automatically.
 */

import type { MutableRefObject } from 'react';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  isMountedRef?: MutableRefObject<boolean>;
}

/**
 * Check if a value looks like a Supabase response with an error.
 * Supabase responses have shape: { data: T | null, error: PostgrestError | null }
 */
function hasSupabaseError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    'error' in result &&
    (result as any).error !== null &&
    typeof (result as any).error === 'object' &&
    typeof (result as any).error.message === 'string'
  );
}

export async function retryFetch<T>(
  fn: () => PromiseLike<T> | Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 1000, isMountedRef } = options;
  let lastError: unknown;
  let lastResult: T | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail if component unmounted between retries
    if (isMountedRef && !isMountedRef.current) {
      throw new Error('Component unmounted during retry');
    }

    try {
      const result = await fn();

      // SUPABASE-AWARE: If the result has an error, treat it as a retryable failure.
      // But DON'T throw — store the result and retry. After all retries exhausted,
      // return the last result (with error) so callers' `if (error)` fallbacks work.
      if (hasSupabaseError(result)) {
        lastResult = result;
        lastError = new Error(`Supabase error: ${(result as any).error.message}`);
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // All retries exhausted — return the error result (don't throw)
        return result;
      }

      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // If we have a Supabase result with error, return it instead of throwing
  // This preserves the original { data, error } contract
  if (lastResult !== undefined) {
    return lastResult;
  }

  throw lastError;
}

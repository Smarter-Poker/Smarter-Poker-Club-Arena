/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RETRY FETCH — Exponential backoff wrapper for Supabase queries
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps any async function with automatic retry on failure.
 * Uses exponential backoff: 1s → 2s → 4s (configurable).
 * Respects isMounted ref to avoid retrying after unmount.
 *
 * IMPORTANT: Supabase SDK returns `{ data, error }` instead of throwing.
 * This wrapper detects `{ error }` in the result and throws it so retries fire.
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
function hasSupabaseError(result: unknown): result is { error: { message: string } } {
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

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail if component unmounted between retries
    if (isMountedRef && !isMountedRef.current) {
      throw new Error('Component unmounted during retry');
    }

    try {
      const result = await fn();

      // CRITICAL: Supabase SDK returns { data, error } instead of throwing.
      // If the result has an error property, throw it to trigger retry logic.
      if (hasSupabaseError(result)) {
        throw new Error(`Supabase error: ${(result as any).error.message}`);
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

  throw lastError;
}

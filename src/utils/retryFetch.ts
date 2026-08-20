/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RETRY FETCH — Exponential backoff wrapper for Supabase queries
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CANONICAL RETRY UTILITY for component-level (React) Supabase queries.
 * Use this when you need:
 *   - Supabase-aware retry (detects `{ error }` responses, not just thrown errors)
 *   - isMounted guard to prevent state updates after unmount
 *
 * For service-level retries (non-React, thrown-error only), see retryAsync.ts.
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

/**
 * PostgREST/Postgres conditions that will fail identically no matter how many
 * times we ask. Retrying them just burns the caller's timeout budget before its
 * fallback runs — e.g. PGRST202 (function not found) is precisely the case a
 * caller's legacy fallback exists for, and it used to cost 3s of backoff first.
 */
const NON_RETRYABLE_CODES = new Set([
  'PGRST202', // schema cache: function/route does not exist
  'PGRST301', // JWT invalid / not authenticated
  '42501', // insufficient privilege
  '42883', // undefined function
  '42P01', // undefined table
  '22P02', // invalid text representation (bad argument)
  '23505', // unique violation
]);

function isNonRetryable(result: unknown): boolean {
  const code = (result as any)?.error?.code;
  return typeof code === 'string' && NON_RETRYABLE_CODES.has(code);
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
      // Tagged so callers can tell "the user navigated away" apart from a real
      // failure and skip error reporting for it.
      const unmounted = new Error('Component unmounted during retry');
      unmounted.name = 'Unmounted';
      throw unmounted;
    }

    try {
      const result = await fn();

      // SUPABASE-AWARE: If the result has an error, treat it as a retryable failure.
      // But DON'T throw — store the result and retry. After all retries exhausted,
      // return the last result (with error) so callers' `if (error)` fallbacks work.
      if (hasSupabaseError(result)) {
        lastResult = result;
        lastError = new Error(`Supabase error: ${(result as any).error.message}`);
        // Deterministic failure: hand it back now so the caller can fall back
        // immediately instead of waiting out the backoff for the same answer.
        if (isNonRetryable(result)) {
          return result;
        }
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
      // A later attempt THREW, so the earlier attempt's { error } result is no
      // longer the truth about this call. Returning it below would report a
      // stale Postgres error instead of the real failure (e.g. a network drop).
      lastResult = undefined;
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

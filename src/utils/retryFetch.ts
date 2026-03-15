/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RETRY FETCH — Exponential backoff wrapper for Supabase queries
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps any async function with automatic retry on failure.
 * Uses exponential backoff: 1s → 2s → 4s (configurable).
 * Respects isMounted ref to avoid retrying after unmount.
 */

import type { MutableRefObject } from 'react';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  isMountedRef?: MutableRefObject<boolean>;
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
      return await fn();
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

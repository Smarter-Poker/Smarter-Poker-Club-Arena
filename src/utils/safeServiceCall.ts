/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SAFE SERVICE CALL — Prevents service-thrown errors from crashing pages
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Problem:
 * Many service methods (WalletService, ClubService, UnionService, etc.) use
 * `throw error` or `throw new Error(...)` to signal failures. When a page
 * component calls these in a useEffect or event handler, the thrown error
 * propagates as an unhandled promise rejection, causing:
 *
 * 1. React can't catch async errors in error boundaries
 * 2. The page goes into an undefined state (partial render, stale data)
 * 3. No user-visible feedback about what went wrong
 *
 * Solution:
 * Wrap service calls with `safeServiceCall()` which catches thrown errors and
 * returns a `{ data, error }` tuple, just like Supabase's own API pattern.
 * Pages can then handle errors gracefully (show toast, retry, etc.)
 *
 * Usage:
 *   const { data, error } = await safeServiceCall(() => walletService.getBalances(userId));
 *   if (error) { toast.error(error); return; }
 *   setBalances(data);
 */

export interface SafeResult<T> {
  data: T | null;
  error: string | null;
}

/**
 * Wraps an async service call so thrown errors become { data: null, error: message }
 * instead of crashing the caller.
 */
export async function safeServiceCall<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (err: any) {
    const message = err?.message || err?.error_description || 'An unexpected error occurred';
    console.warn('[SafeServiceCall] Caught thrown error:', message);
    return { data: null, error: message };
  }
}

/**
 * Wraps a SYNC service call (rare, but some services have sync methods).
 */
export function safeServiceCallSync<T>(fn: () => T): SafeResult<T> {
  try {
    const data = fn();
    return { data, error: null };
  } catch (err: any) {
    const message = err?.message || err?.error_description || 'An unexpected error occurred';
    console.warn('[SafeServiceCallSync] Caught thrown error:', message);
    return { data: null, error: message };
  }
}

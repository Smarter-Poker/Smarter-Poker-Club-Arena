/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USE VISIBILITY REFRESH — Auto-refresh stale data on tab focus
 * ═══════════════════════════════════════════════════════════════════════════════
 * When the user switches back to the tab after being away for 30+ seconds,
 * calls the provided refresh function. Deduplicates concurrent calls.
 *
 * Performance: Uses useRef to store the callback so the event listener is
 * registered ONCE on mount, not re-registered on every render.
 */

import { useEffect, useRef, useCallback } from 'react';

const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export function useVisibilityRefresh(refreshFn: () => void | Promise<void>) {
  const refreshFnRef = useRef(refreshFn);
  const lastFetchRef = useRef(Date.now());
  const isRefreshingRef = useRef(false);

  // Always keep ref in sync with latest callback (no effect re-run needed)
  refreshFnRef.current = refreshFn;

  // Track when data was last fetched
  const markFresh = useCallback(() => {
    lastFetchRef.current = Date.now();
  }, []);

  useEffect(() => {
    // Mark fresh on mount
    lastFetchRef.current = Date.now();

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      if (isRefreshingRef.current) return;

      const elapsed = Date.now() - lastFetchRef.current;
      if (elapsed < STALE_THRESHOLD_MS) return;

      isRefreshingRef.current = true;
      try {
        await refreshFnRef.current();
        lastFetchRef.current = Date.now();
      } catch (err) {
        console.warn('[useVisibilityRefresh] Refresh failed:', err);
      } finally {
        isRefreshingRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []); // Mount-only — callback accessed via ref

  return { markFresh };
}

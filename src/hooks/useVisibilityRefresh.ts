/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USE VISIBILITY REFRESH — Auto-refresh stale data on tab focus
 * ═══════════════════════════════════════════════════════════════════════════════
 * When the user switches back to the tab after being away for 30+ seconds,
 * calls the provided refresh function. Deduplicates concurrent calls.
 *
 * Performance: Uses useRef to store the callback so the event listener is
 * registered ONCE on mount, not re-registered on every render.
 *
 * Returns: { markFresh, isRefreshing }
 *  - markFresh: call after manual data fetch to reset the staleness timer
 *  - isRefreshing: true while background refresh is in progress (for UI indicator)
 */

import { useEffect, useRef, useCallback, useState } from 'react';

const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export function useVisibilityRefresh(refreshFn: () => void | Promise<void>) {
  const refreshFnRef = useRef(refreshFn);
  const lastFetchRef = useRef(Date.now());
  const isRefreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  /* Synced in an effect, not in the render body. Writing a ref while
     rendering is a side effect: React 19 may begin a render and discard it,
     and a visibilitychange landing in that window would then run a callback
     belonging to props that were never committed. No dep array, so it tracks
     every commit. */
  useEffect(() => {
    refreshFnRef.current = refreshFn;
  });

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
      setIsRefreshing(true);
      try {
        await refreshFnRef.current();
        lastFetchRef.current = Date.now();
      } catch (err) {
        console.warn('[useVisibilityRefresh] Refresh failed:', err);
      } finally {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []); // Mount-only — callback accessed via ref

  return { markFresh, isRefreshing };
}

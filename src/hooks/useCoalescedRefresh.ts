import { useCallback, useEffect, useRef } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REALTIME FEED IS A FRESHNESS SIGNAL, NOT A RENDER LOOP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "CLUBS SHOULD NOT BE 'RANDOMLY REFRESHING' ON THERE OWN, IT
 * FEELS LIKE A BUG OR GLITCH THAT SHOULDN'T HAPPEN ... ITS ALSO HAPPENING
 * INSIDE OF THE TABLE MANAGEMENT PAGE, FIX IT FOR EVERY PAGE AND SUB PAGE OF
 * THE CLUB ARENA."
 *
 * Every Club Arena surface is wired the same way: subscribe to a table, and on
 * each row event re-read the page. That is correct when the table changes a few
 * times an hour and catastrophic when it changes several times a second - and
 * on a live floor, the tables these pages watch change several times a second:
 *
 *   club_members         every buy-in and cash-out moves a chip_balance
 *   game_management_events  2,108 rows in ten minutes for ONE club (2026-09-02)
 *   tables               one UPDATE per hand, per table
 *
 * So the page rebuilt itself continuously. The player sees a screen that
 * refreshes at random; the database sees the whole lobby payload re-read
 * 100+ times a minute across the estate.
 *
 * Postgres does not tell us WHICH column changed - these tables use the default
 * replica identity, so an UPDATE payload carries the new row and nothing to
 * compare it against, and raising them to REPLICA IDENTITY FULL would multiply
 * the WAL volume that is already the realtime pipeline's bottleneck. Since we
 * cannot cheaply tell a chip tick from a promotion, we stop trying: the page
 * re-reads on a floor, not on an event.
 *
 *   - At most one refresh per `minIntervalMs`, however many events arrive.
 *   - Nothing at all while the tab is hidden; one refresh on return if events
 *     were missed.
 *   - `refreshNow()` for the operator's own actions, which must never wait.
 *
 * The result is a page that is at most `minIntervalMs` stale and never visibly
 * rebuilds itself. Pair it with `mergeById` at the call site so the refresh
 * that does happen keeps the identity of every row it did not change.
 */
export function useCoalescedRefresh(
  refresh: () => void,
  { minIntervalMs = 20_000 }: { minIntervalMs?: number } = {}
): { request: () => void; refreshNow: () => void } {
  const refreshRef = useRef(refresh);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAtRef = useRef(0);
  const missedRef = useRef(false);
  const mountedRef = useRef(true);

  // Always call the newest closure: these hooks live next to data loaders that
  // are redefined every render, and holding render-0's copy is how a refresh
  // ends up repainting a club the operator has already left.
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const run = useCallback(() => {
    lastAtRef.current = Date.now();
    missedRef.current = false;
    if (mountedRef.current) refreshRef.current();
  }, []);

  const request = useCallback(() => {
    if (timerRef.current) return; // one already scheduled; this event rides it
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      missedRef.current = true;
      return;
    }
    const since = Date.now() - lastAtRef.current;
    if (since >= minIntervalMs) {
      run();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      run();
    }, minIntervalMs - since);
  }, [minIntervalMs, run]);

  const refreshNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    run();
  }, [run]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!missedRef.current) return;
      // Whatever was missed is one read on return, not a queue of them.
      lastAtRef.current = 0;
      request();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [request]);

  return { request, refreshNow };
}

export default useCoalescedRefresh;

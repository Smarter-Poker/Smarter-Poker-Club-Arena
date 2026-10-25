/**
 * Which bytes count against the route-performance transfer budget.
 *
 * 2026-10-25: the gate summed `transferSize` over EVERY resource entry the
 * page had recorded by the time it measured (load + FCP wait + 500ms). That
 * snapshot races the app's own deliberate speculative work: ChunkPreloader
 * schedules its chunk warm-up from requestIdleCallback (ten page chunks,
 * staggered 150ms apart) and then the deck warmer (~500KB of WebP, 3s
 * later). Whether those land before the snapshot depends on runner load, so
 * the same build measured /hub/club-arena/health at 1096kB on mobile and
 * 3173kB on tablet in one run of PR #7972, and a re-run with no code change
 * passed. A budget that a slow runner can flip is not a budget.
 *
 * THE RULE. The budget is the initial-load cost:
 *   - the navigation document itself (its own transferSize, which the old sum
 *     never counted at all), plus
 *   - every resource whose fetch STARTED before the boundary, where the
 *     boundary is the EARLIER of
 *       a. the load event (`navigation.loadEventStart`): what the browser
 *          itself counts as the page's load, and
 *       b. the moment the page's first requestIdleCallback callback ran
 *          (recorded by an init script that wraps rIC without changing it).
 *          Idle work is speculative by definition, and on a slow load an
 *          idle period can open before `load` fires; anything the idle
 *          preloader requests starts at or after that instant, so it can
 *          never leak into the initial set however the runner is loaded.
 * The static critical set (document, entry module, its modulepreloads and
 * stylesheets) is requested while the HTML is parsed, before any script can
 * register an idle callback, so it is always counted: a genuinely bloated
 * initial load still fails the 3MB budget.
 *
 * FAIL CLOSED. If the navigation entry has no load timestamp (load never
 * fired, or the entry is missing), there is no boundary the browser vouches
 * for, so every resource counts, exactly as the old gate did. The rule may
 * only ever exclude bytes the browser proves were requested after the
 * boundary; it never invents a boundary from a missing number.
 *
 * The total is still returned so the log keeps after-boundary growth visible.
 */
export function initialLoadBoundary(navigation, firstIdleCallbackAt) {
  const load = navigation && navigation.loadEventStart;
  if (!(Number.isFinite(load) && load > 0)) return null;
  if (Number.isFinite(firstIdleCallbackAt) && firstIdleCallbackAt > 0) {
    return Math.min(load, firstIdleCallbackAt);
  }
  return load;
}

export function initialLoadTransfer(navigation, resources, firstIdleCallbackAt = null) {
  const list = Array.isArray(resources) ? resources : [];
  const boundary = initialLoadBoundary(navigation, firstIdleCallbackAt);
  const documentBytes = (navigation && navigation.transferSize) || 0;

  let initialResourceBytes = 0;
  let lateBytes = 0;
  let lateCount = 0;
  for (const entry of list) {
    const bytes = (entry && entry.transferSize) || 0;
    if (boundary === null || !Number.isFinite(entry?.startTime) || entry.startTime < boundary) {
      initialResourceBytes += bytes;
    } else {
      lateBytes += bytes;
      lateCount += 1;
    }
  }

  return {
    boundaryMs: boundary,
    initialBytes: documentBytes + initialResourceBytes,
    lateBytes,
    lateCount,
    totalBytes: documentBytes + initialResourceBytes + lateBytes,
  };
}

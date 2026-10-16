/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHERE THE RAIL STARTS - extracted from TournamentStartingTicker 2026-09-05
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The measurement rule and every hard-won reason behind it live in
 * `topChrome.ts`, which is pure and asserted directly. This is the DOM half:
 * measure on mount, on resize, and whenever the chrome itself changes size.
 *
 * It was inline in the component, where it was one of eight jobs that component
 * was doing. Nothing about the behaviour changes here - the effect is the same
 * effect, including late header mount detection, which exists because the
 * global header can mount after the route does and a ResizeObserver cannot
 * observe an element that is not there yet.
 */

import { useLayoutEffect, useState } from 'react';
import { measureTopChromeBottom, TOP_CHROME_SELECTORS } from './topChrome';

/**
 * @param routeKey re-measure when this changes (the pathname, in practice)
 * @returns the y-coordinate the rail should start at, never negative
 */
export function useTopChromeOffset(routeKey: string): number {
  const [headerBottom, setHeaderBottom] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      setHeaderBottom(measureTopChromeBottom((sel) => document.querySelector(sel)));
    };
    measure();
    window.addEventListener('resize', measure);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
    }

    // A lazy header can mount after the old two-second settling deadline.
    // Observe that mount event, then let ResizeObserver carry its geometry.
    let mounts: MutationObserver | null = null;
    const attach = () => {
      let found = false;
      for (const sel of TOP_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) {
          found = true;
          ro?.observe(el);
        }
      }
      measure();
      if (found) mounts?.disconnect();
      return found;
    };
    if (!attach() && typeof MutationObserver !== 'undefined') {
      mounts = new MutationObserver(attach);
      mounts.observe(document.body, { childList: true, subtree: true });
    }
    // Capture nested lobby scrolls as well as the window scroll. Position can
    // change without a resize when a sticky header reaches its scroll limit.
    document.addEventListener('scroll', measure, true);

    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
      mounts?.disconnect();
      ro?.disconnect();
    };
  }, [routeKey]);

  return headerBottom;
}

export default useTopChromeOffset;

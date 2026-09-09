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
 * effect, including the two-second settling poll, which exists because the
 * global header can mount after the route does and a ResizeObserver cannot
 * observe an element that is not there yet.
 */

import { useEffect, useState } from 'react';
import { measureTopChromeBottom, TOP_CHROME_SELECTORS } from './topChrome';

/**
 * @param routeKey re-measure when this changes (the pathname, in practice)
 * @returns the y-coordinate the rail should start at, never negative
 */
export function useTopChromeOffset(routeKey: string): number {
  const [headerBottom, setHeaderBottom] = useState(0);

  useEffect(() => {
    const measure = () => {
      setHeaderBottom(measureTopChromeBottom((sel) => document.querySelector(sel)));
    };
    measure();
    window.addEventListener('resize', measure);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
    }

    /* Observe every candidate, not just the first one found, and re-attach on
       each tick: observe() is idempotent per element, so this is free and it
       picks up chrome that mounts late. The rail itself only appears when an
       MTT comes inside the five-minute window, which is usually long after the
       route did. */
    let attempts = 0;
    const attach = () => {
      measure();
      if (!ro) return;
      for (const sel of TOP_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) ro.observe(el);
      }
    };
    attach();
    const poll = setInterval(() => {
      attach();
      if (++attempts > 20) clearInterval(poll); // 2s of settling, then observers carry it
    }, 100);

    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(poll);
      ro?.disconnect();
    };
  }, [routeKey]);

  return headerBottom;
}

export default useTopChromeOffset;

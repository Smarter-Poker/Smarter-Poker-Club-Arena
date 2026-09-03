import { useLayoutEffect, useRef } from 'react';

/**
 * Shrink a single-line label until it fits its zone.
 *
 * Dan 2026-09-03: "REDUCE THE FONT SIZE IN NLH STRADDLE, SO THAT 'STRADDLE'
 * FITS WITHOUT CUTTING OFF." The layered cards print into fixed pixel zones
 * measured off the approved master, so a long table name has nowhere to wrap
 * - it was simply clipped at the zone edge ("NLH Straddl", "Short Deck ").
 *
 * The hook measures the rendered text against the zone and writes the ratio
 * into a `--fit` custom property on the text element; the stylesheet folds it
 * into `font-size: calc(<base> * var(--fit, 1))`. It never grows text past its
 * designed size (ratio is capped at 1) and re-measures whenever the zone
 * resizes, so the same card fits a 320px phone and a 430px one.
 *
 * `scaleX` is the horizontal stretch the stylesheet applies via transform
 * (transforms do not affect scrollWidth, so they must be accounted for here).
 */
export function useFitText<T extends HTMLElement = HTMLElement>(
  text: string,
  scaleX = 1,
  minRatio = 0.5
) {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zone = el.parentElement;
    if (!zone) return;

    const fit = () => {
      el.style.setProperty('--fit', '1');
      const available = zone.clientWidth;
      const needed = el.scrollWidth * scaleX;
      if (!available || !needed) return;
      const ratio = Math.min(1, Math.max(minRatio, available / needed));
      el.style.setProperty('--fit', ratio < 0.995 ? ratio.toFixed(3) : '1');
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(zone);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    return () => observer.disconnect();
  }, [text, scaleX, minRatio]);

  return ref;
}

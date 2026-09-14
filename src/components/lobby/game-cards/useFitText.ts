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
 *
 * WHY THIS ITERATES. Rendered width is not proportional to font-size: glyph
 * hinting and per-glyph letter-spacing both round, so a ratio derived from one
 * measurement of the full-size text lands a few per cent wide. Measured on the
 * console plates 2026-09-13: an 82.8px face needed 0.601, which predicted
 * 82.98px and actually rendered 87.09px - 4.3px over, with the last letter of
 * "Save Changes" sitting on the painted rim, which is the one thing the fit
 * exists to prevent. Callers had begun passing an inflated `scaleX` as a
 * private safety margin to compensate. So instead of trusting the estimate,
 * apply it, measure what really happened, and correct - which converges in two
 * passes and needs no per-caller fudge.
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
      /* clientWidth is an integer, so on an 82.8px face it reports 83 and
         licenses 0.2px of overflow. Take the fractional box where there is no
         border to subtract, and the integer content box where there is. */
      const available = Math.min(zone.clientWidth, zone.getBoundingClientRect().width);
      const needed = el.scrollWidth * scaleX;
      if (!available || !needed) return;
      /* Already fits at its designed size: never grow it. */
      if (needed <= available) {
        el.style.setProperty('--fit', '1');
        return;
      }

      let ratio = Math.max(minRatio, available / needed);
      for (let pass = 0; pass < 4; pass += 1) {
        el.style.setProperty('--fit', ratio.toFixed(4));
        const actual = el.scrollWidth * scaleX;
        if (actual <= available || ratio <= minRatio) break;
        const corrected = Math.max(minRatio, ratio * (available / actual));
        if (ratio - corrected < 0.0005) break;
        ratio = corrected;
      }
      el.style.setProperty('--fit', ratio >= 0.995 ? '1' : ratio.toFixed(4));
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

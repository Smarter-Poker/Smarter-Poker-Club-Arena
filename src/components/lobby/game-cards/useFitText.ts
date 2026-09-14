import { useLayoutEffect, useRef } from 'react';

/**
 * Shrink a single-line label until it fits its zone (or, where the caller
 * allows it, let it take a second line - see FitTextOptions).
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
export type FitTextOptions = {
  /**
   * Let the label take a second line instead of shrinking below this ratio.
   *
   * The four-bay deck (2026-09-14): its two plates are a third of the
   * console wide, and the honest buy-in labels ("Buy In With Diamonds",
   * "Retry Original Buy-In", "Balance Unavailable") are pinned by tests and by
   * the ledger law - they cannot be shortened. On one line they hit the floor
   * at half size and still lost their last letters to the rim. A real button
   * carries a long label on two lines, so that is what the plate does.
   *
   * When the one-line fit lands under `wrapBelow`, the hook marks the element
   * `data-fit-wrap="true"` and measures again; the stylesheet decides what a
   * wrapped label looks like (white-space, its own base size, line-height).
   * The wrapped result is kept only when it renders larger than the one-line
   * result - never a smaller face on more lines. The block may take at most
   * `maxLines` lines and its widest unbreakable run must fit the zone; re-flow
   * is discrete, so the hook steps down and re-measures until both hold.
   */
  wrapBelow?: number;
  /** Lines a wrapped label may take. Default 2. */
  maxLines?: number;
};

export function useFitText<T extends HTMLElement = HTMLElement>(
  text: string,
  scaleX = 1,
  minRatio = 0.5,
  options?: FitTextOptions
) {
  const ref = useRef<T | null>(null);
  const wrapBelow = options?.wrapBelow;
  const maxLines = options?.maxLines ?? 2;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zone = el.parentElement;
    if (!zone) return;

    /* clientWidth is an integer, so on an 82.8px face it reports 83 and
       licenses 0.2px of overflow. Take the fractional box where there is no
       border to subtract, and the integer content box where there is. */
    const available = () => Math.min(zone.clientWidth, zone.getBoundingClientRect().width);
    const setFit = (ratio: number) =>
      el.style.setProperty('--fit', ratio >= 0.995 ? '1' : ratio.toFixed(4));
    const fontPx = () => parseFloat(getComputedStyle(el).fontSize) || 0;

    /* One line: shrink until it fits, converging on what really rendered. */
    const fitLine = (): number => {
      el.style.setProperty('--fit', '1');
      const room = available();
      const needed = el.scrollWidth * scaleX;
      /* Nothing to measure (jsdom), or it already fits at its designed size:
         never grow it. */
      if (!room || !needed || needed <= room) return 1;

      let ratio = Math.max(minRatio, room / needed);
      for (let pass = 0; pass < 4; pass += 1) {
        el.style.setProperty('--fit', ratio.toFixed(4));
        const actual = el.scrollWidth * scaleX;
        if (actual <= room || ratio <= minRatio) break;
        const corrected = Math.max(minRatio, ratio * (room / actual));
        if (ratio - corrected < 0.0005) break;
        ratio = corrected;
      }
      return ratio;
    };

    /* Wrapped: the widest line must fit the zone and the block must stay
       within maxLines. Lines are read off the text's own client rects (one
       per line box), which are fractional: a block that fills its zone has an
       integer scrollWidth a hair over the zone's fractional width, and
       measuring that way never converges. Returns null when no ratio above
       the floor satisfies both. */
    const wrappedLines = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects());
      let widest = 0;
      for (const rect of rects) widest = Math.max(widest, rect.width);
      return { lines: rects.length, widest: widest * scaleX };
    };
    const fitWrapped = (): number | null => {
      el.dataset.fitWrap = 'true';
      let ratio = 1;
      for (let pass = 0; pass < 8; pass += 1) {
        el.style.setProperty('--fit', ratio.toFixed(4));
        const room = available();
        const { lines, widest } = wrappedLines();
        if (!lines) return null;
        const wide = widest > room + 0.5;
        const tall = lines > maxLines;
        if (!wide && !tall) return ratio;
        if (ratio <= minRatio) return null;
        let next = ratio;
        if (wide) next = Math.min(next, ratio * (room / widest));
        /* Re-flow is discrete: a line count only changes at a word boundary,
           so step down and look again. */
        if (tall) next = Math.min(next, ratio * 0.94);
        next = Math.max(minRatio, next);
        if (ratio - next < 0.0005) return null;
        ratio = next;
      }
      return null;
    };

    const fit = () => {
      delete el.dataset.fitWrap;
      const line = fitLine();
      if (wrapBelow === undefined || line >= wrapBelow) {
        setFit(line);
        return;
      }
      const linePx = fontPx();
      const wrapped = fitWrapped();
      if (wrapped !== null && fontPx() > linePx * 1.05) {
        setFit(wrapped);
        return;
      }
      delete el.dataset.fitWrap;
      setFit(line);
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(zone);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    return () => observer.disconnect();
  }, [text, scaleX, minRatio, wrapBelow, maxLines]);

  return ref;
}

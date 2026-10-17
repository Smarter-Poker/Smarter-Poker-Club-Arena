import { useLayoutEffect, useRef } from 'react';
import { cancelTextFit, queueTextFit, type FitTextTarget } from './fitTextBatch';

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
  /** Defer measurement until the owning surface is ready; other callers fit immediately. */
  enabled?: boolean;
  /**
   * Let the label take a second line instead of shrinking below this ratio.
   *
   * The riveted frame and the deck (2026-09-14): their plates are a third of
   * the console wide, and the honest money labels ("Buy In With Diamonds",
   * "Request Cashout", "Retry Original Buy-In") are pinned by tests and by
   * the ledger law - they cannot be shortened. On one line they hit the floor
   * at half size and still lost their last letters to the rim. A real button
   * carries a long label on two lines, so that is what the plate does.
   *
   * When the one-line fit lands under `wrapBelow`, the hook marks the element
   * `data-fit-wrap="true"` and measures again; the stylesheet decides what a
   * wrapped label looks like (white-space, its own base size, line-height).
   * The wrapped result is kept only when it renders larger than the one-line
   * result - never a smaller face on more lines. The block may take at most
   * `maxLines` lines and its widest line must fit the zone; re-flow is
   * discrete, so the hook steps down and re-measures until both hold.
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
  const enabled = options?.enabled ?? true;

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const zone = el.parentElement;
    if (!zone) return;

    // The same layout algorithm now runs one shared read/write cohort before
    // paint, instead of forcing a layout for every label on the game board.
    const target: FitTextTarget = { element: el, zone, scaleX, minRatio, wrapBelow, maxLines };
    let active = true;
    const fit = () => {
      if (active) queueTextFit(target);
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(zone);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    return () => {
      active = false;
      observer?.disconnect();
      cancelTextFit(target);
    };
  }, [text, scaleX, minRatio, wrapBelow, maxLines, enabled]);

  return ref;
}

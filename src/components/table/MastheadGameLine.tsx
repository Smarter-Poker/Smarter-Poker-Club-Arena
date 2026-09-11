/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE GAME LINE FITS ITS BOX (audit 2026-09-09, lane H)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Masthead line 2 on a cash table is "MADNESS NLH 1/2 + BB Ante": the style,
 * the game, the stakes and the ante on ONE line (Dan 2026-09-07, 7B). It is
 * sized in container units against the masthead box - `clamp(0.6rem, 10.5cqw,
 * 0.98rem)` in TablePage.css - and 10.5cqw was measured for "NLH 0.10/0.25"
 * ALONE, thirteen characters. The style went in front of it and the ante
 * behind it the same day, and nobody re-measured.
 *
 * Rendered headless against the real stylesheet on 2026-09-09: at 375px the
 * box is 154px and the row is 14.4px, so "MADNESS NLH 1/2 + BB ANTE" (25
 * characters, ~230px) ellipsized to "MADNESS NLH 1/..." - the stakes and the
 * ante gone on exactly the Action and Madness tables where the ante is the
 * point. At 393px (178px box, 15.7px) the same. "1/..." is not a shorter way
 * of writing the stakes, the way "MIDWAY U..." was not a shorter name (7A).
 *
 * So the line measures itself, the way every card title does (useFitText):
 * the rendered width against the row's box, and `--fit` scales the font down
 * until it fits - never up, never below MIN_RATIO of the designed size. If
 * even the floor cannot hold it (a thirty-character micro-stakes Action line
 * on a 375px phone) it WRAPS at the floor size rather than ellipsizing: two
 * short lines still say the stakes, three dots do not. On a desktop, where
 * the box is wide, `--fit` stays at 1 and nothing changes.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Never below this fraction of the row's designed size: 14.4px -> 7.9px at
    375px, 15.7px -> 8.6px at 393px, the size of the VPIP row beneath it. */
export const MASTHEAD_GAME_MIN_RATIO = 0.55;

/**
 * The fit, as a pure function of the widths, so the rule is testable without
 * a layout engine: the ratio to apply (1 = designed size) and whether the line
 * has to wrap because even the floor cannot hold it. `current` is the ratio
 * the measurement was taken at, so a second pass can correct the first.
 */
export function mastheadGameFit(
  needed: number,
  available: number,
  minRatio = MASTHEAD_GAME_MIN_RATIO,
  current = 1
): { ratio: number; wrap: boolean } {
  if (!needed || !available || needed <= available) return { ratio: current, wrap: false };
  const raw = current * (available / needed);
  if (raw >= minRatio) return { ratio: Number(raw.toFixed(3)), wrap: false };
  return { ratio: minRatio, wrap: true };
}

/** Measured headless on 2026-09-09: a line scaled to exactly the ratio that
    should fit it still overran by 3-6px at 375px, because glyph advances are
    rounded at small sizes and do not scale linearly. One correcting pass,
    measured at the size just applied, closes that; a third would not add
    anything a phone can show. */
export const MASTHEAD_GAME_FIT_PASSES = 2;

/** `text-overflow: ellipsis` fires on ANY overflow, and layout widths are
    integers: a line fitted to exactly its box came back 1px over and lost its
    last letter to three dots. The box is measured this much narrower than it
    is, so "fits" means fits with a pixel to spare. */
export const MASTHEAD_GAME_FIT_MARGIN_PX = 2;

/**
 * The class is the caller's (`table-brand__game`, defined in TablePage.css,
 * which TablePage imports): a className has to resolve in a stylesheet the
 * file that names it loads (tests/unit/classNamesResolve.test.ts), and this
 * file loads none. It only measures and fits.
 */
export function MastheadGameLine({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zone = el.parentElement;
    if (!zone) return;

    const fit = () => {
      /* Measure at the designed size, unwrapped, apply, then measure once
         more at the size just applied and correct. */
      el.style.setProperty('--fit', '1');
      el.removeAttribute('data-wrap');
      let ratio = 1;
      let wrap = false;
      for (let pass = 0; pass < MASTHEAD_GAME_FIT_PASSES; pass += 1) {
        const available = zone.clientWidth - MASTHEAD_GAME_FIT_MARGIN_PX;
        const needed = el.scrollWidth;
        ({ ratio, wrap } = mastheadGameFit(needed, available, MASTHEAD_GAME_MIN_RATIO, ratio));
        el.style.setProperty('--fit', ratio < 0.995 ? String(ratio) : '1');
        if (wrap || needed <= available) break;
      }
      if (wrap) el.setAttribute('data-wrap', 'true');
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(zone);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}

export default MastheadGameLine;

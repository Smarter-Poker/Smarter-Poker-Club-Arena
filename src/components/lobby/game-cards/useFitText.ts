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

interface FitTextTarget {
  element: HTMLElement;
  zone: HTMLElement;
  scaleX: number;
  minRatio: number;
  wrapBelow?: number;
  maxLines: number;
}

type Step = { kind: 'read' | 'write'; run: () => unknown };
type Fit = Generator<Step, void, unknown>;

/** The same bounded fitting algorithm, with DOM reads and writes separated. */
function* fitText(target: FitTextTarget): Fit {
  const { element: el, zone, scaleX, minRatio, wrapBelow, maxLines } = target;
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const available = () => {
    const css = getComputedStyle(zone);
    const innerWidth =
      pixels(css.width) +
      (css.boxSizing === 'border-box'
        ? -pixels(css.borderLeftWidth) - pixels(css.borderRightWidth)
        : pixels(css.paddingLeft) + pixels(css.paddingRight));
    return Math.min(zone.clientWidth, innerWidth || zone.clientWidth);
  };
  const fitValue = (ratio: number) =>
    ratio >= 0.995 ? '1' : String(Math.floor(ratio * 10000) / 10000);
  const setFit = (ratio: number) => el.style.setProperty('--fit', fitValue(ratio));
  const fontPx = () => pixels(getComputedStyle(el).fontSize);

  function* fitLine(): Generator<Step, number, unknown> {
    yield { kind: 'write', run: () => el.style.setProperty('--fit', '1') };
    const { room, needed } = (yield {
      kind: 'read',
      run: () => ({ room: available(), needed: el.scrollWidth * scaleX }),
    }) as { room: number; needed: number };
    if (!room || !needed || needed <= room) return 1;
    let ratio = Math.max(minRatio, room / needed);
    for (let pass = 0; pass < 4; pass += 1) {
      yield {
        kind: 'write',
        run: () => el.style.setProperty('--fit', String(Math.floor(ratio * 10000) / 10000)),
      };
      const actual = (yield { kind: 'read', run: () => el.scrollWidth * scaleX }) as number;
      if (actual <= room || ratio <= minRatio) break;
      const corrected = Math.max(minRatio, ratio * (room / actual));
      if (ratio - corrected < 0.0005) break;
      ratio = corrected;
    }
    return ratio;
  }

  const wrappedLines = () => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    const room = available();
    const scale = room ? zone.getBoundingClientRect().width / room || 1 : 1;
    let widest = 0;
    for (const rect of rects) widest = Math.max(widest, rect.width / scale);
    return { room, lines: rects.length, widest: widest * scaleX };
  };

  function* fitWrapped(): Generator<Step, number | null, unknown> {
    yield { kind: 'write', run: () => (el.dataset.fitWrap = 'true') };
    let ratio = 1;
    for (let pass = 0; pass < 8; pass += 1) {
      yield {
        kind: 'write',
        run: () => el.style.setProperty('--fit', String(Math.floor(ratio * 10000) / 10000)),
      };
      const { room, lines, widest } = (yield { kind: 'read', run: wrappedLines }) as {
        room: number;
        lines: number;
        widest: number;
      };
      if (!lines) return null;
      const wide = widest > room + 0.5;
      const tall = lines > maxLines;
      if (!wide && !tall) return ratio;
      if (ratio <= minRatio) return null;
      let next = ratio;
      if (wide) next = Math.min(next, ratio * (room / widest));
      if (tall) next = Math.min(next, ratio * 0.94);
      next = Math.max(minRatio, next);
      if (ratio - next < 0.0005) return null;
      ratio = next;
    }
    return null;
  }

  yield { kind: 'write', run: () => delete el.dataset.fitWrap };
  const line = yield* fitLine();
  if (wrapBelow === undefined || line >= wrapBelow) {
    yield { kind: 'write', run: () => setFit(line) };
    return;
  }
  const linePx = (yield { kind: 'read', run: fontPx }) as number;
  const wrapped = yield* fitWrapped();
  if (wrapped !== null && ((yield { kind: 'read', run: fontPx }) as number) > linePx * 1.05) {
    yield { kind: 'write', run: () => setFit(wrapped) };
    return;
  }
  yield {
    kind: 'write',
    run: () => {
      delete el.dataset.fitWrap;
      setFit(line);
    },
  };
}

/**
 * Fit one render cohort. Every write phase finishes before any measurement;
 * hundreds of labels therefore share the same layout instead of invalidating
 * it once per label. The original four/eight measurement passes remain finite.
 */
function fitTextBatch(targets: Iterable<FitTextTarget>): void {
  const work = new Map<Fit, Step>();
  const advance = (fit: Fit, value?: unknown) => {
    const next = fit.next(value);
    if (next.done) work.delete(fit);
    else work.set(fit, next.value);
  };
  for (const target of targets) advance(fitText(target));
  while (work.size) {
    const writes = [...work].filter(([, step]) => step.kind === 'write');
    if (writes.length) {
      for (const [fit, step] of writes) {
        step.run();
        advance(fit);
      }
    } else {
      // Finish all reads before advancing a job to its next write.
      const measured = [...work].map(([fit, step]) => [fit, step.run()] as const);
      for (const [fit, value] of measured) advance(fit, value);
    }
  }
}

const pending = new Set<FitTextTarget>();
let frame: number | null = null;

/** Resize, font readiness and mount requests coalesce before the next paint. */
function queueTextFit(target: FitTextTarget): void {
  pending.add(target);
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const cohort = [...pending].filter(({ element }) => element.isConnected);
    pending.clear();
    fitTextBatch(cohort);
  });
}

function cancelTextFit(target: FitTextTarget): void {
  pending.delete(target);
  if (pending.size || frame === null) return;
  cancelAnimationFrame(frame);
  frame = null;
}

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

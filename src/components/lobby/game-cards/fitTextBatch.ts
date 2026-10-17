export interface FitTextTarget {
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
export function fitTextBatch(targets: Iterable<FitTextTarget>): void {
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
export function queueTextFit(target: FitTextTarget): void {
  pending.add(target);
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const cohort = [...pending].filter(({ element }) => element.isConnected);
    pending.clear();
    fitTextBatch(cohort);
  });
}

export function cancelTextFit(target: FitTextTarget): void {
  pending.delete(target);
  if (pending.size || frame === null) return;
  cancelAnimationFrame(frame);
  frame = null;
}

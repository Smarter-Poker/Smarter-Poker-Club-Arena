/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  POSITION INDICATOR — the pill stays in the middle, the clubs move past it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An endless carousel has a cost: with no ends, there is no edge to tell you
 * where you are or how much there is. Dan's whole reason for the carousel was
 * "unlimited amounts of clubs", so this has to stay readable at 3 clubs and at
 * 30.
 *
 * WHAT CHANGED, 2026-08-23
 *
 * Dan: "you see the dot dot pill under the midway card now? the pill should be
 * in the middle and dots on each side for the other cards."
 *
 * It used to render one dot per club in list order and light up the one you
 * were on, so with Midway Union third of three the pill sat hard right - under
 * nothing, pointing at nothing, while the card it described was dead centre.
 * The indicator disagreed with the carousel about where the middle was.
 *
 * Now the pill IS the middle. Slot `half` always holds the current club and the
 * neighbours fan out either side, wrapping exactly the way the strip wraps
 * (`(current + o) mod total`), so the row of dots is a small window onto an
 * endless list rather than a map of a finite one. It reads the same at 3 clubs
 * and at 300.
 *
 * That also retires the old "3 / 27" counter mode. Above eight clubs the dots
 * used to vanish entirely and be replaced by text, which meant the control you
 * could tap to jump between clubs disappeared exactly when you had enough clubs
 * to need it. A window of seven never outgrows its space, so the dots can stay
 * and stay tappable. The count survives as a small label beside them, because
 * "how many are there" is the one thing an endless strip genuinely cannot show.
 */
import './CarouselDots.css';

/**
 * How many dots the window holds. Odd on purpose: an even count has no middle
 * slot, and the middle slot is the entire point.
 */
export const DOT_WINDOW = 7;

/** Retained name for the old counter threshold; the count label now appears
 *  ALONGSIDE the dots rather than replacing them. */
export const MAX_DOTS = DOT_WINDOW;

export interface CarouselDotsProps {
  total: number;
  current: number;
  onChange: (index: number) => void;
  /** Names the thing being paged through, for screen readers. */
  itemNoun?: string;
}

/**
 * The dots to draw, and which club each one jumps to.
 *
 * Exported for the tests: "the pill is in the middle" is a claim about this
 * array, and checking it here is exact where checking rendered pixels is not.
 */
export function dotWindow(
  total: number,
  current: number,
  window: number = DOT_WINDOW
): { index: number; isCurrent: boolean }[] {
  if (total <= 0) return [];
  const count = Math.min(total, Math.max(1, window));
  /* Which slot the current club sits in. For an odd count this is the exact
     middle. For 2, 4 or 6 clubs there IS no exact middle, and the choice is
     between putting the pill half a slot off-centre or hiding somebody's club
     from the row - so it sits half a slot off-centre. Above six clubs the
     window is a full seven and the pill is dead centre again, forever. */
  const centreSlot = Math.floor(count / 2);
  const out: { index: number; isCurrent: boolean }[] = [];
  for (let slot = 0; slot < count; slot++) {
    const offset = slot - centreSlot;
    const index = (((current + offset) % total) + total) % total;
    out.push({ index, isCurrent: slot === centreSlot });
  }
  return out;
}

export function CarouselDots({ total, current, onChange, itemNoun = 'Card' }: CarouselDotsProps) {
  if (total <= 1) return null;

  const dots = dotWindow(total, current);

  return (
    <div className="carousel-dots" role="tablist" aria-label={`${itemNoun} Position`}>
      {dots.map(({ index, isCurrent }, slot) => (
        <button
          /* Keyed on the SLOT, not the club index. The window slides, so the
             club at a given slot changes on every swipe; keying on the club
             would tear down and rebuild the whole row each time and throw away
             the pill's width transition. */
          key={slot}
          type="button"
          role="tab"
          aria-selected={isCurrent}
          aria-label={`${itemNoun} ${index + 1} Of ${total}`}
          className={`dot ${isCurrent ? 'active' : ''}`}
          onClick={() => onChange(index)}
        />
      ))}
      {total > DOT_WINDOW && (
        /* aria-live so a screen reader announces the change after a swipe,
           which is otherwise a silent event for a non-sighted user. */
        <span className="carousel-counter" aria-live="polite">
          {current + 1} / {total}
        </span>
      )}
    </div>
  );
}

export default CarouselDots;

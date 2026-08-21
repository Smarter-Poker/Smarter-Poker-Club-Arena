/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  POSITION INDICATOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An endless carousel has a cost: with no ends, there is no edge to tell you
 * where you are or how much there is. Dan's whole reason for the carousel was
 * "unlimited amounts of clubs", so this has to stay readable at 3 clubs and at
 * 30.
 *
 *   few  -> dots, one per club, tappable
 *   many -> "3 / 27", because thirty dots is not a control, it is a texture
 *
 * The previous version rendered a bare <button> per item with no label, no
 * pressed state and no bound on the count.
 */
import './CarouselDots.css';

/** Above this many items, dots stop being useful and become a counter. */
export const MAX_DOTS = 8;

export interface CarouselDotsProps {
  total: number;
  current: number;
  onChange: (index: number) => void;
  /** Names the thing being paged through, for screen readers. */
  itemNoun?: string;
}

export function CarouselDots({ total, current, onChange, itemNoun = 'Card' }: CarouselDotsProps) {
  if (total <= 1) return null;

  if (total > MAX_DOTS) {
    return (
      <div className="carousel-dots carousel-dots--counter">
        {/* aria-live so a screen reader announces the change after a swipe,
            which is otherwise a silent event for a non-sighted user. */}
        <span className="carousel-counter" aria-live="polite">
          {current + 1} / {total}
        </span>
      </div>
    );
  }

  return (
    <div className="carousel-dots" role="tablist" aria-label={`${itemNoun} Position`}>
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === current}
          aria-label={`${itemNoun} ${i + 1} Of ${total}`}
          className={`dot ${i === current ? 'active' : ''}`}
          onClick={() => onChange(i)}
        />
      ))}
    </div>
  );
}

export default CarouselDots;

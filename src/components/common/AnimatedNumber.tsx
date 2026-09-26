/**
 * AnimatedNumber — Smooth count-up/down number display
 * Used for pot amounts, stack sizes, and any numeric display that changes.
 * Animates smoothly between values using requestAnimationFrame.
 *
 * ── THE COUNT NEVER PRINTS A CHIP THAT DOES NOT EXIST (Dan 2026-09-23) ─────
 * "THE POT IS SOMEHOW SHOWING 4.97 WHEN THIS IS A 1/2 GAME AND NO PLAYER HAS
 * BET OR DONE ANYTHING AS A FRACTION. THIS BUG MUST BE FIXED."
 *
 * The count-up interpolated the raw float between the two pot totals and
 * handed every frame to the formatter, so a pot going 0 -> 5 was drawn as
 * 3.41, 4.62, 4.97 on its way - and the formatter, which keeps a real
 * fraction on purpose (a 7.50 pot at 1/2 must read 7.50), printed them. Any
 * frame a screenshot lands on is a number that was never in the pot.
 *
 * Every intermediate frame is now snapped to the coarsest grid both ends of
 * the count sit on: two whole numbers count through whole numbers, and
 * anything else counts in cents, which is the finest grain a chip has. The
 * motion is unchanged; only the frames that were lies are gone. The last
 * frame is the target itself, exactly, as before.
 */

import { useState, useEffect, useRef } from 'react';

interface AnimatedNumberProps {
  value: number;
  /** Duration of the animation in ms (default: 400) */
  duration?: number;
  /** Format function (default: toLocaleString) */
  format?: (n: number) => string;
  /** CSS class for the wrapper span */
  className?: string;
}

function defaultFormat(n: number): string {
  if (n >= 1) return Math.round(n).toLocaleString('en-US');
  if (n > 0) return n.toFixed(2);
  return '0';
}

/** A figure squared off at the cent. The chips a pot is made of never carry a
    third decimal; anything past it is float noise from a rake split or a
    subtraction (5.000000000000001, 0.30000000000000004). */
const toCents = (n: number): number => Math.round(n * 100) / 100;

/** The grid an intermediate frame may land on: whole chips when both ends of
    the count are whole, cents otherwise. A chip divides into cents and no
    further, so no frame ever needs a third decimal.

    Judged on the cent-squared values, not the raw ones (2026-09-24): the pot
    pill is fed `mainPot - streetBets` straight from the snapshot, and a 5
    that arrives as 5.000000000000001 is not an integer to `Number.isInteger`,
    which put the count back on the cent grid and printed 4.97 again. */
export function countGrid(from: number, to: number): number {
  return Number.isInteger(toCents(from)) && Number.isInteger(toCents(to)) ? 1 : 0.01;
}

/** `raw` snapped to `grid`, squared off at the cent so float noise from the
    multiply never leaks a 4.970000000000001 into a formatter. */
export function snapToGrid(raw: number, grid: number): number {
  return Math.round(Math.round(raw / grid) * grid * 100) / 100;
}

export function AnimatedNumber({
  value,
  duration = 400,
  format = defaultFormat,
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;

    // Skip animation for initial render or zero change
    if (from === to) {
      setDisplay(to);
      return;
    }

    const start = performance.now();
    const diff = to - from;
    const grid = countGrid(from, to);

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = snapToGrid(from + diff * eased, grid);

      setDisplay(current);

      if (progress < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
      }
    };

    animRef.current = requestAnimationFrame(tick);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [value, duration]);

  return <span className={className}>{format(display)}</span>;
}

export default AnimatedNumber;

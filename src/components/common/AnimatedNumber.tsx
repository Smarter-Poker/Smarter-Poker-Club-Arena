/**
 * AnimatedNumber — Smooth count-up/down number display
 * Used for pot amounts, stack sizes, and any numeric display that changes.
 * Animates smoothly between values using requestAnimationFrame.
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

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + diff * eased;

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

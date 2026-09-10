import React, { useState, useEffect, useRef } from 'react';
import './AnimatedCounter.css';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
}

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  duration = 1000,
  prefix = '',
  suffix = '',
}) => {
  const [displayValue, setDisplayValue] = useState(0);

  /* ONE LOOP AT A TIME, AND NONE AFTER UNMOUNT (2026-09-10). The frame id
     was never captured and the effect had no cleanup, so a value change
     mid-animation started a second loop fighting the first over
     setDisplayValue, and the loop kept setting state after unmount. The
     start value is read from a ref so a re-run does not need displayValue in
     its deps (which would restart the loop on every frame). */
  const displayRef = useRef(0);
  displayRef.current = displayValue;

  useEffect(() => {
    let start: number | null = null;
    let frame = 0;
    const startValue = displayRef.current;
    const diff = value - startValue;

    const animate = (timestamp: number) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(startValue + diff * eased));

      if (progress < 1) {
        frame = requestAnimationFrame(animate);
      }
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return (
    <span className="animated-counter">
      {prefix}
      {displayValue.toLocaleString()}
      {suffix}
    </span>
  );
};

export default AnimatedCounter;

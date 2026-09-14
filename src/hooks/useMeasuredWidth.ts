import { useEffect, useRef, useState } from 'react';

/**
 * The inner width of a container, kept current by ResizeObserver, so a canvas
 * can be sized to the cavity it sits in rather than guessed from the window.
 */
export function useMeasuredWidth<T extends HTMLElement>(
  fallback = 320
): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

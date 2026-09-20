import { useEffect, useState } from 'react';

/**
 * The inner width of a container, kept current by ResizeObserver, so a canvas
 * can be sized to the cavity it sits in rather than guessed from the window.
 */
export function useMeasuredWidth<T extends HTMLElement>(
  fallback = 320
): [React.RefCallback<T>, number] {
  // The stage may mount only after its asynchronous game state has loaded.
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element) return;
    const read = () => {
      const w = Math.floor(element.clientWidth);
      if (w > 0) setWidth(w);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);
  return [setElement, width];
}

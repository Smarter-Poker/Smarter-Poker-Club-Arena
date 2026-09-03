import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

interface VirtualScrollOptions {
  itemHeight?: number;
  viewportHeight?: number;
  buffer?: number;
  initialCount?: number;
  pageSize?: number;
}

interface VirtualScrollResult<T> {
  visibleItems: T[];
  containerRef: React.RefObject<HTMLDivElement>;
  sentinelRef: React.RefObject<HTMLDivElement>;
  hasMore: boolean;
  totalCount: number;
  visibleCount: number;
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
  reset: () => void;
}

/**
 * Fixed-height windowing with row recycling. Only the viewport plus overscan is
 * mounted; a 10,000-player roster keeps roughly a dozen row trees in the DOM.
 */
export function useVirtualScroll<T>(
  items: T[],
  options: VirtualScrollOptions = {}
): VirtualScrollResult<T> {
  const { itemHeight = 112, viewportHeight = 640, buffer = 6 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // The viewport is conditionally mounted after the first page arrives. On a
  // true cold load the ref is null during the hook's first effect; an empty
  // dependency list therefore never attaches a scroll listener and the window
  // remains frozen on its first slice. Re-run when the list crosses the
  // empty/non-empty boundary so the newly mounted viewport is always wired.
  const hasItems = items.length > 0;
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setScrollTop(node.scrollTop);
    update();
    node.addEventListener('scroll', update, { passive: true });
    return () => node.removeEventListener('scroll', update);
  }, [hasItems]);

  const visibleCapacity = Math.max(1, Math.ceil(viewportHeight / itemHeight));
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
  const endIndex = Math.min(items.length, startIndex + visibleCapacity + buffer * 2);
  const visibleItems = useMemo(
    () => items.slice(startIndex, endIndex),
    [items, startIndex, endIndex]
  );

  const reset = useCallback(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    setScrollTop(0);
  }, []);

  return {
    visibleItems,
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    sentinelRef: sentinelRef as React.RefObject<HTMLDivElement>,
    hasMore: endIndex < items.length,
    totalCount: items.length,
    visibleCount: visibleItems.length,
    startIndex,
    endIndex,
    paddingTop: startIndex * itemHeight,
    paddingBottom: Math.max(0, (items.length - endIndex) * itemHeight),
    reset,
  };
}

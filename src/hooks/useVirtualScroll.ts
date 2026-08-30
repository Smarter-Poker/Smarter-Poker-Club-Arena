/**
 * useVirtualScroll — IntersectionObserver-based windowed rendering
 *
 * Renders only visible items + buffer to prevent DOM bloat on long lists.
 * No external dependencies — uses native IntersectionObserver.
 *
 * Usage:
 *   const { visibleItems, containerRef, sentinelRef } = useVirtualScroll(items, { buffer: 5 });
 *   return (
 *     <div ref={containerRef}>
 *       {visibleItems.map(item => <Row key={item.id} />)}
 *       <div ref={sentinelRef} />
 *     </div>
 *   );
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

interface VirtualScrollOptions {
  /** How many items to render beyond the visible window (default: 10) */
  buffer?: number;
  /** Initial number of items to render (default: 20) */
  initialCount?: number;
  /** How many more items to load when sentinel is intersected (default: 20) */
  pageSize?: number;
}

interface VirtualScrollResult<T> {
  /** The subset of items currently rendered */
  visibleItems: T[];
  /** Ref to attach to the scroll container */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Ref to attach to the sentinel element (placed at the bottom) */
  sentinelRef: React.RefObject<HTMLDivElement>;
  /** Whether there are more items to show */
  hasMore: boolean;
  /** Total items count */
  totalCount: number;
  /** Currently visible count */
  visibleCount: number;
  /** Reset the virtual window (e.g., on filter change) */
  reset: () => void;
}

export function useVirtualScroll<T>(
  items: T[],
  options: VirtualScrollOptions = {}
): VirtualScrollResult<T> {
  const { buffer = 10, initialCount = 20, pageSize = 20 } = options;

  const [visibleCount, setVisibleCount] = useState(Math.min(initialCount, items.length));
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(items.length);

  // Reset visible count when items change length (new data loaded)
  useEffect(() => {
    if (items.length !== prevLengthRef.current) {
      setVisibleCount(Math.min(initialCount, items.length));
      prevLengthRef.current = items.length;
    }
  }, [items.length, initialCount]);

  // IntersectionObserver to load more items when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + pageSize, items.length));
        }
      },
      {
        root: containerRef.current,
        rootMargin: `${buffer * 50}px`, // Buffer zone in pixels
        threshold: 0.1,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [items.length, buffer, pageSize]);

  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);

  const reset = useCallback(() => {
    setVisibleCount(Math.min(initialCount, items.length));
  }, [initialCount, items.length]);

  return {
    visibleItems,
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    sentinelRef: sentinelRef as React.RefObject<HTMLDivElement>,
    hasMore: visibleCount < items.length,
    totalCount: items.length,
    visibleCount,
    reset,
  };
}

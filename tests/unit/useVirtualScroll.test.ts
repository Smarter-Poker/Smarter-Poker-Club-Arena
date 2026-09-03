/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useVirtualScroll
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useVirtualScroll } from '../../src/hooks/useVirtualScroll';

describe('useVirtualScroll', () => {
  it('should be a function export', () => {
    expect(typeof useVirtualScroll).toBe('function');
  });

  it('should return visible items for small dataset', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, viewportHeight: 300 })
    );
    expect(result.current).toBeDefined();
    expect(Array.isArray(result.current.visibleItems)).toBe(true);
  });

  it('should return totalCount matching item count', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, viewportHeight: 300, buffer: 2 })
    );
    expect(result.current.totalCount).toBe(100);
    expect(result.current.visibleItems.length).toBeLessThan(100);
    expect(result.current.paddingBottom).toBeGreaterThan(0);
  });

  it('should handle empty dataset', () => {
    const { result } = renderHook(() =>
      useVirtualScroll([], { itemHeight: 50, viewportHeight: 300 })
    );
    expect(result.current.visibleItems).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
  });

  it('should return hasMore flag', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, viewportHeight: 300 })
    );
    expect(typeof result.current.hasMore).toBe('boolean');
  });

  it('should return reset function', () => {
    const items = [{ id: 1 }];
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, viewportHeight: 300 })
    );
    expect(typeof result.current.reset).toBe('function');
  });

  it('attaches scrolling when a cold-load viewport mounts after rows arrive', () => {
    function Harness({ items }: { items: number[] }) {
      const virtual = useVirtualScroll(items, {
        itemHeight: 50,
        viewportHeight: 200,
        buffer: 1,
      });
      return createElement(
        'div',
        null,
        items.length > 0
          ? createElement('div', { ref: virtual.containerRef, 'data-testid': 'viewport' })
          : null,
        createElement('output', { 'data-testid': 'start' }, String(virtual.startIndex))
      );
    }

    const view = render(createElement(Harness, { items: [] }));
    view.rerender(createElement(Harness, { items: Array.from({ length: 100 }, (_, i) => i) }));
    const viewport = screen.getByTestId('viewport');
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 500 });
    fireEvent.scroll(viewport);
    expect(Number(screen.getByTestId('start').textContent)).toBeGreaterThan(0);
  });
});

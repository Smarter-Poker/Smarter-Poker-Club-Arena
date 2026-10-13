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

  it('commits only when a pixel scroll changes the mounted slice', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    let renders = 0;
    function Harness() {
      renders += 1;
      const virtual = useVirtualScroll(items, { itemHeight: 50, viewportHeight: 200, buffer: 1 });
      return createElement(
        'div',
        { ref: virtual.containerRef, 'data-testid': 'measured-viewport' },
        createElement('output', { 'data-testid': 'measured-start' }, String(virtual.startIndex))
      );
    }
    render(createElement(Harness));
    const viewport = screen.getByTestId('measured-viewport');
    const scroll = (top: number) => {
      Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: top });
      fireEvent.scroll(viewport);
    };
    const initial = renders;
    for (const top of [1, 5, 10, 20, 30, 40, 49, 50, 60, 70, 80, 99]) scroll(top);
    expect(renders - initial).toBe(0);
    scroll(100);
    expect(screen.getByTestId('measured-start').textContent).toBe('1');
    expect(renders - initial).toBe(1);
    const moved = renders;
    for (const top of [101, 110, 125, 149]) scroll(top);
    expect(renders - moved).toBe(0);
    scroll(50);
    expect(screen.getByTestId('measured-start').textContent).toBe('0');
    expect(renders - moved).toBe(1);
  });

  it('keeps a populated final slice after a scrolled dataset shrinks', () => {
    function Harness({ items }: { items: number[] }) {
      const virtual = useVirtualScroll(items, { itemHeight: 50, viewportHeight: 200, buffer: 1 });
      return createElement(
        'div',
        { ref: virtual.containerRef, 'data-testid': 'shrink-viewport' },
        createElement('output', { 'data-testid': 'shrink-items' }, virtual.visibleItems.join(',')),
        createElement('output', { 'data-testid': 'shrink-start' }, String(virtual.startIndex))
      );
    }
    const view = render(
      createElement(Harness, { items: Array.from({ length: 100 }, (_, i) => i) })
    );
    const viewport = screen.getByTestId('shrink-viewport');
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 4_500 });
    fireEvent.scroll(viewport);
    view.rerender(createElement(Harness, { items: Array.from({ length: 8 }, (_, i) => i) }));
    expect(screen.getByTestId('shrink-items').textContent).toBe('2,3,4,5,6,7');
    expect(screen.getByTestId('shrink-start').textContent).toBe('2');
  });

  it('recomputes a changed row height and buffer from the current DOM position', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    function Harness({ height, buffer }: { height: number; buffer: number }) {
      const virtual = useVirtualScroll(items, { itemHeight: height, viewportHeight: 200, buffer });
      return createElement(
        'div',
        { ref: virtual.containerRef, 'data-testid': 'config-viewport' },
        createElement('output', { 'data-testid': 'config-start' }, String(virtual.startIndex))
      );
    }
    const view = render(createElement(Harness, { height: 50, buffer: 1 }));
    const viewport = screen.getByTestId('config-viewport');
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      value: 500,
      writable: true,
    });
    fireEvent.scroll(viewport);
    expect(screen.getByTestId('config-start').textContent).toBe('9');
    // A return-position write may occur before the browser's next scroll event.
    viewport.scrollTop = 800;
    view.rerender(createElement(Harness, { height: 100, buffer: 2 }));
    expect(screen.getByTestId('config-start').textContent).toBe('6');
    viewport.scrollTop = 1_000;
    fireEvent.scroll(viewport);
    expect(screen.getByTestId('config-start').textContent).toBe('8');
  });

  it('resets DOM and slice ownership, then admits a new restored position', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    function Harness() {
      const virtual = useVirtualScroll(items, { itemHeight: 50, viewportHeight: 200, buffer: 1 });
      return createElement(
        'div',
        { ref: virtual.containerRef, 'data-testid': 'reset-viewport' },
        createElement('button', { onClick: virtual.reset }, 'Reset Slice'),
        createElement('output', { 'data-testid': 'reset-start' }, String(virtual.startIndex))
      );
    }
    render(createElement(Harness));
    const viewport = screen.getByTestId('reset-viewport');
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      value: 500,
      writable: true,
    });
    fireEvent.scroll(viewport);
    expect(screen.getByTestId('reset-start').textContent).toBe('9');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Slice' }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.getByTestId('reset-start').textContent).toBe('0');
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    expect(screen.getByTestId('reset-start').textContent).toBe('9');
  });
});

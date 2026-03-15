/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useVirtualScroll
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVirtualScroll } from '../../src/hooks/useVirtualScroll';

describe('useVirtualScroll', () => {
  it('should be a function export', () => {
    expect(typeof useVirtualScroll).toBe('function');
  });

  it('should return visible items for small dataset', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(result.current).toBeDefined();
    expect(Array.isArray(result.current.visibleItems)).toBe(true);
  });

  it('should return totalCount matching item count', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(result.current.totalCount).toBe(100);
  });

  it('should handle empty dataset', () => {
    const { result } = renderHook(() =>
      useVirtualScroll([], { itemHeight: 50, containerHeight: 300 })
    );
    expect(result.current.visibleItems).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
  });

  it('should return hasMore flag', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(typeof result.current.hasMore).toBe('boolean');
  });

  it('should return reset function', () => {
    const items = [{ id: 1 }];
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(typeof result.current.reset).toBe('function');
  });
});

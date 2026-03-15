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

  it('should return virtual items for small dataset', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(result.current).toBeDefined();
    expect(Array.isArray(result.current.virtualItems)).toBe(true);
  });

  it('should return totalHeight', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() =>
      useVirtualScroll(items, { itemHeight: 50, containerHeight: 300 })
    );
    expect(typeof result.current.totalHeight).toBe('number');
    expect(result.current.totalHeight).toBe(5000); // 100 * 50
  });

  it('should handle empty dataset', () => {
    const { result } = renderHook(() =>
      useVirtualScroll([], { itemHeight: 50, containerHeight: 300 })
    );
    expect(result.current.virtualItems).toHaveLength(0);
    expect(result.current.totalHeight).toBe(0);
  });
});

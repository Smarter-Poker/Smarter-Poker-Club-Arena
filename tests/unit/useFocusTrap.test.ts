/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useFocusTrap (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFocusTrap } from '../../src/hooks/useFocusTrap';

describe('useFocusTrap', () => {
  it('should export useFocusTrap as a function', () => {
    expect(typeof useFocusTrap).toBe('function');
  });

  it('should return a ref object when inactive', () => {
    const { result } = renderHook(() => useFocusTrap(false));
    expect(result.current).toBeDefined();
    expect(result.current.current).toBeNull();
  });

  it('should return a ref object when active', () => {
    const { result } = renderHook(() => useFocusTrap(true));
    expect(result.current).toBeDefined();
  });

  it('should toggle between active and inactive', () => {
    const { result, rerender } = renderHook(({ active }) => useFocusTrap(active), {
      initialProps: { active: false },
    });
    expect(result.current.current).toBeNull();
    rerender({ active: true });
    expect(result.current).toBeDefined();
  });
});

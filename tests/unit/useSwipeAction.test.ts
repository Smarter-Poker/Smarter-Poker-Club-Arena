/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSwipeAction (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSwipeAction } from '../../src/hooks/useSwipeAction';

describe('useSwipeAction', () => {
  it('should export useSwipeAction as a function', () => {
    expect(typeof useSwipeAction).toBe('function');
  });

  it('should return handlers, rowStyle, offset, revealed, reset', () => {
    const { result } = renderHook(() => useSwipeAction());
    expect(result.current.handlers).toBeDefined();
    expect(result.current.rowStyle).toBeDefined();
    expect(result.current.offset).toBe(0);
    expect(result.current.revealed).toBeNull();
    expect(typeof result.current.reset).toBe('function');
  });

  it('should have pointer event handlers', () => {
    const { result } = renderHook(() => useSwipeAction());
    expect(typeof result.current.handlers.onPointerDown).toBe('function');
    expect(typeof result.current.handlers.onPointerMove).toBe('function');
    expect(typeof result.current.handlers.onPointerUp).toBe('function');
    expect(typeof result.current.handlers.onPointerCancel).toBe('function');
  });

  it('should include transform in rowStyle', () => {
    const { result } = renderHook(() => useSwipeAction());
    expect(result.current.rowStyle.transform).toContain('translateX');
  });

  it('should accept custom actionWidth and threshold', () => {
    const { result } = renderHook(() => useSwipeAction({ actionWidth: 100, threshold: 60 }));
    expect(result.current.offset).toBe(0);
  });
});

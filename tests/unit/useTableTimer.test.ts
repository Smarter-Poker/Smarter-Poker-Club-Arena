/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableTimer
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTableTimer } from '../../src/hooks/useTableTimer';

describe('useTableTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should be a function export', () => {
    expect(typeof useTableTimer).toBe('function');
  });

  it('should return timer state', () => {
    const { result } = renderHook(() => useTableTimer({ totalSeconds: 30, isMyTurn: false }));
    expect(result.current).toBeDefined();
  });

  it('should return remaining seconds', () => {
    const { result } = renderHook(() => useTableTimer({ totalSeconds: 30, isMyTurn: false }));
    expect(typeof result.current.remaining).toBe('number');
  });

  it('should return percentage', () => {
    const { result } = renderHook(() => useTableTimer({ totalSeconds: 30, isMyTurn: false }));
    expect(typeof result.current.percentage).toBe('number');
  });

  it('should return isExpired flag', () => {
    const { result } = renderHook(() => useTableTimer({ totalSeconds: 30, isMyTurn: false }));
    expect(typeof result.current.isExpired).toBe('boolean');
  });
});

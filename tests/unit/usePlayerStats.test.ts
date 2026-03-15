/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — usePlayerStats
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePlayerStats } from '../../src/hooks/usePlayerStats';

describe('usePlayerStats', () => {
  it('should be a function export', () => {
    expect(typeof usePlayerStats).toBe('function');
  });

  it('should return getStats function', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.getStats).toBe('function');
  });

  it('should return recordHandPlayed function', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.recordHandPlayed).toBe('function');
  });

  it('should return recordVPIP function', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.recordVPIP).toBe('function');
  });

  it('should return clearStats function', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(typeof result.current.clearStats).toBe('function');
  });

  it('should start with empty statsMap', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(result.current.statsMap).toBeDefined();
    expect(Object.keys(result.current.statsMap)).toHaveLength(0);
  });

  it('should return null for unknown player stats', () => {
    const { result } = renderHook(() => usePlayerStats());
    expect(result.current.getStats('unknown')).toBeNull();
  });

  it('should record a hand played', () => {
    const { result } = renderHook(() => usePlayerStats());
    act(() => {
      result.current.recordHandPlayed('p1');
    });
    expect(result.current.getStats('p1')?.handsPlayed).toBe(1);
  });
});

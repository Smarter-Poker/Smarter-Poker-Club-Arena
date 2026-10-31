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
  it('keeps the same opponent separate across cash and tournament samples', () => {
    const cash = renderHook(() => usePlayerStats('mode-observer', 'cash'));
    const tournament = renderHook(() => usePlayerStats('mode-observer', 'tournament'));
    act(() => {
      cash.result.current.recordHandPlayed('same-opponent');
      cash.result.current.recordVPIP('same-opponent');
      tournament.result.current.recordHandPlayed('same-opponent');
      tournament.result.current.recordHandPlayed('same-opponent');
    });
    expect(cash.result.current.getStats('same-opponent')?.handsPlayed).toBe(1);
    expect(cash.result.current.getStats('same-opponent')?.vpipCount).toBe(1);
    expect(tournament.result.current.getStats('same-opponent')?.handsPlayed).toBe(2);
    expect(tournament.result.current.getStats('same-opponent')?.vpipCount).toBe(0);
  });
});

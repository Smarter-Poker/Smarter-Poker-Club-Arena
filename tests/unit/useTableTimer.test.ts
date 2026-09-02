/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableTimer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-25: the hook returns an ActionClockStore rather than three loose
 * numbers, because returning the numbers meant the CALLER (TablePage) held them
 * in state and re-rendered the whole table once a second for the length of every
 * turn. The values themselves are unchanged — they are read off the snapshot
 * here instead of off `result.current`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SoundService before importing the hook
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    startTimerWarning: vi.fn(),
    stopTimerWarning: vi.fn(),
  },
}));

import { renderHook } from '@testing-library/react';
import { useTableTimer } from '../../src/hooks/useTableTimer';

describe('useTableTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should be a function export', () => {
    expect(typeof useTableTimer).toBe('function');
  });

  it('should return timer state', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(result.current).toBeDefined();
  });

  it('should publish timeRemaining as number', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.clock.getSnapshot().seconds).toBe('number');
  });

  it('should publish timerProgress as number', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.clock.getSnapshot().progress).toBe('number');
  });

  it('should publish isUrgent flag', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.clock.getSnapshot().isUrgent).toBe('boolean');
  });

  it('should return resetTimer function', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.resetTimer).toBe('function');
  });

  it('should not be urgent when not hero turn', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(result.current.clock.getSnapshot().isUrgent).toBe(false);
  });

  it('should default to 15 seconds', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(result.current.clock.getSnapshot().seconds).toBe(15);
  });

  it('hands back the SAME store on every render, so subscribers are never orphaned', () => {
    const { result, rerender } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    const first = result.current.clock;
    rerender();
    rerender();
    expect(result.current.clock).toBe(first);
  });
});

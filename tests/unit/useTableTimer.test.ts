/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableTimer
 * ═══════════════════════════════════════════════════════════════════════════════
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

  it('should return timeRemaining as number', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.timeRemaining).toBe('number');
  });

  it('should return timerProgress as number', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.timerProgress).toBe('number');
  });

  it('should return isUrgent flag', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(typeof result.current.isUrgent).toBe('boolean');
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
    expect(result.current.isUrgent).toBe(false);
  });

  it('should default to 15 seconds', () => {
    const { result } = renderHook(() =>
      useTableTimer({ isHeroTurn: false, isSoundEnabled: false, onTimeout: vi.fn() })
    );
    expect(result.current.timeRemaining).toBe(15);
  });
});

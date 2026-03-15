/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useArenaStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  },
}));

vi.mock('../../src/services/ArenaTrainingController', () => ({
  LEVELS: Array.from({ length: 10 }, (_, i) => ({
    level: i + 1,
    name: `Level ${i + 1}`,
    timer_seconds: 30 - i * 2,
    difficulty: 'easy',
    mastery_threshold: 0.85,
    min_questions: 20,
  })),
  ArenaTrainingController: {
    startSession: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useArenaStore } from '../../src/stores/useArenaStore';

describe('useArenaStore', () => {
  beforeEach(() => {
    useArenaStore.setState({
      currentSession: null,
      currentStreak: 0,
      bestStreak: 0,
      isLoadingStats: false,
    });
  });

  it('should start with null session', () => {
    expect(useArenaStore.getState().currentSession).toBeNull();
  });

  it('should start with 0 streak', () => {
    expect(useArenaStore.getState().currentStreak).toBe(0);
  });

  it('should start with 0 best streak', () => {
    expect(useArenaStore.getState().bestStreak).toBe(0);
  });

  it('should not be loading stats by default', () => {
    expect(useArenaStore.getState().isLoadingStats).toBe(false);
  });

  it('should export store with training actions', () => {
    const state = useArenaStore.getState();
    expect(typeof state.loadStats).toBe('function');
    expect(typeof state.startTraining).toBe('function');
    expect(typeof state.recordAnswer).toBe('function');
    expect(typeof state.endSession).toBe('function');
    expect(typeof state.updateTimer).toBe('function');
    expect(typeof state.loadUnlockedLevel).toBe('function');
    expect(typeof state.addLeakSignal).toBe('function');
    expect(typeof state.clearLeakSignal).toBe('function');
    expect(typeof state.reset).toBe('function');
  });
});

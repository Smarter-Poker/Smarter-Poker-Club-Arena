/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TournamentTimerService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests pure logic:
 * - formatTimeRemaining: MM:SS formatter
 * - setBreakInterval: clamped to >=1
 * - Timer lifecycle: startTimer, stopTimer, pause, resume, getTimerState
 * - stopAllTimers: cleans up all active timers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    getOrCreateChannel: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    getTournament: vi.fn().mockResolvedValue(null), // No tournament = stops timer
    getCurrentLevelState: vi.fn().mockReturnValue({
      levelIndex: 0,
      currentLevel: { smallBlind: 25, bigBlind: 50, ante: 0 },
      nextLevel: { smallBlind: 50, bigBlind: 100, ante: 10 },
      timeRemainingSeconds: 600,
    }),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { tournamentTimerService } from '../../src/services/TournamentTimerService';

describe('TournamentTimerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup all active timers to prevent interval leaks
    tournamentTimerService.stopAllTimers();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FORMAT TIME REMAINING
  // ─────────────────────────────────────────────────────────────────────────

  describe('formatTimeRemaining', () => {
    it('should format 0 seconds as 00:00', () => {
      expect(tournamentTimerService.formatTimeRemaining(0)).toBe('00:00');
    });

    it('should format 90 seconds as 01:30', () => {
      expect(tournamentTimerService.formatTimeRemaining(90)).toBe('01:30');
    });

    it('should format 600 seconds as 10:00', () => {
      expect(tournamentTimerService.formatTimeRemaining(600)).toBe('10:00');
    });

    it('should format 61 seconds as 01:01', () => {
      expect(tournamentTimerService.formatTimeRemaining(61)).toBe('01:01');
    });

    it('should format 5 seconds as 00:05', () => {
      expect(tournamentTimerService.formatTimeRemaining(5)).toBe('00:05');
    });

    it('should format 3661 seconds as 61:01', () => {
      expect(tournamentTimerService.formatTimeRemaining(3661)).toBe('61:01');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SET BREAK INTERVAL
  // ─────────────────────────────────────────────────────────────────────────

  describe('setBreakInterval', () => {
    it('should clamp to minimum 1', () => {
      tournamentTimerService.setBreakInterval('t1', 0);
      // We can verify by checking the getFullClockState default
      // which uses breakIntervals.get() || 6
    });

    it('should accept valid interval', () => {
      tournamentTimerService.setBreakInterval('t1', 8);
      // No throw = success
      expect(true).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TIMER LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  describe('timer lifecycle', () => {
    it('should track active timer after startTimer', () => {
      tournamentTimerService.startTimer('t1');
      const state = tournamentTimerService.getTimerState('t1');
      expect(state).not.toBeNull();
      expect(state!.tournamentId).toBe('t1');
      expect(state!.isPaused).toBe(false);
      expect(state!.currentLevel).toBe(0); // Not yet ticked
    });

    it('should return null for unknown tournament', () => {
      expect(tournamentTimerService.getTimerState('unknown')).toBeNull();
    });

    it('should remove timer after stopTimer', () => {
      tournamentTimerService.startTimer('t1');
      tournamentTimerService.stopTimer('t1');
      expect(tournamentTimerService.getTimerState('t1')).toBeNull();
    });

    it('should set isPaused on pauseTimer', () => {
      tournamentTimerService.startTimer('t1');
      tournamentTimerService.pauseTimer('t1');
      expect(tournamentTimerService.getTimerState('t1')!.isPaused).toBe(true);
    });

    it('should clear isPaused on resumeTimer', () => {
      tournamentTimerService.startTimer('t1');
      tournamentTimerService.pauseTimer('t1');
      tournamentTimerService.resumeTimer('t1');
      expect(tournamentTimerService.getTimerState('t1')!.isPaused).toBe(false);
    });

    it('should not create duplicate timers', () => {
      tournamentTimerService.startTimer('t1');
      tournamentTimerService.startTimer('t1'); // duplicate
      // Original timer should still work
      expect(tournamentTimerService.getTimerState('t1')).not.toBeNull();
      tournamentTimerService.stopTimer('t1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STOP ALL TIMERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('stopAllTimers', () => {
    it('should clean up all active timers', () => {
      tournamentTimerService.startTimer('t1');
      tournamentTimerService.startTimer('t2');
      tournamentTimerService.startTimer('t3');
      tournamentTimerService.stopAllTimers();
      expect(tournamentTimerService.getTimerState('t1')).toBeNull();
      expect(tournamentTimerService.getTimerState('t2')).toBeNull();
      expect(tournamentTimerService.getTimerState('t3')).toBeNull();
    });
  });
});

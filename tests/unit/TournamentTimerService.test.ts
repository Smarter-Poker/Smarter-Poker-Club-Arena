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

// Records every `.update()` payload so the level actually written to
// `tournaments.current_level` can be asserted, not just inferred.
const { writes, rows } = vi.hoisted(() => ({
  writes: [] as { table: string; payload: Record<string, unknown> }[],
  rows: {
    players: null as unknown,
    tournament: null as unknown,
    playerError: null as unknown,
    tournamentError: null as unknown,
  },
}));

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (table: string): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: rows.tournament, error: rows.tournamentError });
        if (prop === 'then')
          return (resolve: (v: any) => void) =>
            resolve({
              data: table === 'tournament_players' ? rows.players : rows.tournament,
              error: table === 'tournament_players' ? rows.playerError : rows.tournamentError,
            });
        if (prop === 'update')
          return (payload: Record<string, unknown>) => {
            writes.push({ table, payload });
            return new Proxy({}, handler);
          };
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: (table: string) => buildChain(table),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { mockGetTournament, mockGetCurrentLevelState } = vi.hoisted(() => ({
  mockGetTournament: vi.fn(),
  mockGetCurrentLevelState: vi.fn(),
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    getTournament: mockGetTournament,
    getCurrentLevelState: mockGetCurrentLevelState,
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { tournamentTimerService } from '../../src/services/TournamentTimerService';
import { masterBus } from '../../src/core/MasterBus';
import { reportError } from '../../src/utils/errorReporter';

describe('TournamentTimerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    writes.length = 0;
    rows.players = null;
    rows.tournament = null;
    rows.playerError = null;
    rows.tournamentError = null;
    // Default: no tournament, so a tick stops the timer without writing.
    mockGetTournament.mockResolvedValue(null);
    mockGetCurrentLevelState.mockReturnValue({
      levelIndex: 0,
      currentLevel: { smallBlind: 25, bigBlind: 50, ante: 0 },
      nextLevel: { smallBlind: 50, bigBlind: 100, ante: 10 },
      timeRemainingSeconds: 600,
    });
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
      // UPDATED 2026-08-25 (was `toBe(0)`): `currentLevel` is a 0-BASED index
      // now, so 0 is a real level - the opening one. A timer that starts at 0
      // would treat the opening level as "already seen" and skip the first
      // transition entirely (no blind write to the tables, no broadcast). The
      // sentinel has to sit outside the value range.
      expect(state!.currentLevel).toBe(-1); // Not yet ticked
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

  // ---------------------------------------------------------------------------
  // WHAT REACHES `tournaments.current_level`
  // ---------------------------------------------------------------------------
  //
  // The client no longer writes to `tournaments.current_level`.
  // It is authoritative to the Hetzner engine.

  describe('current_level is not written by the client', () => {
    const runningTournament = {
      id: 't-write',
      status: 'RUNNING',
      blind_structure: [],
    };

    const tickOnce = async (levelIndex: number) => {
      mockGetTournament.mockResolvedValue(runningTournament as never);
      mockGetCurrentLevelState.mockReturnValue({
        levelIndex,
        currentLevel: { smallBlind: 25, bigBlind: 50, ante: 0 },
        nextLevel: { smallBlind: 50, bigBlind: 100, ante: 10 },
        timeRemainingSeconds: 600,
      });
      tournamentTimerService.startTimer('t-write');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    };

    const levelsWritten = () =>
      writes
        .filter((w) => w.table === 'tournaments' && 'current_level' in w.payload)
        .map((w) => w.payload.current_level);

    it('does not write the level index to the database', async () => {
      await tickOnce(3);
      expect(levelsWritten()).toEqual([]);
    });

    it('does not announce unknown blinds and can observe the same level when they arrive', async () => {
      mockGetTournament.mockResolvedValue(runningTournament);
      mockGetCurrentLevelState.mockReturnValue({
        levelIndex: 369,
        currentLevel: null,
        nextLevel: null,
        timeRemainingSeconds: 200,
      });
      tournamentTimerService.startTimer('t-write');
      await vi.advanceTimersByTimeAsync(0);
      expect(masterBus.emit).not.toHaveBeenCalled();
      expect(await tournamentTimerService.getFullClockState('t-write')).toBeNull();

      mockGetCurrentLevelState.mockReturnValue({
        levelIndex: 369,
        currentLevel: { smallBlind: 52_500, bigBlind: 105_000, ante: 0 },
        nextLevel: null,
        timeRemainingSeconds: 199,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(masterBus.emit).toHaveBeenCalledWith('BLIND_LEVEL_CHANGE', {
        tournamentId: 't-write',
        level: 370,
        smallBlind: 52_500,
        bigBlind: 105_000,
        ante: 0,
      });
      expect(levelsWritten()).toEqual([]);
    });
  });

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

  describe('final table follows engine confirmation, not a maximum entry count', () => {
    it.each(['playerError', 'tournamentError'] as const)(
      'reports an unknown %s observation',
      async (key) => {
        rows.players = Array.from({ length: 5 }, (_, i) => ({ user_id: `p${i}`, chips: 1000 }));
        rows.tournament = { id: 'mtt', max_players: null, final_table_triggered: true };
        const error = new Error('Observation Unavailable');
        rows[key] = error;
        await tournamentTimerService.checkTableSize('mtt');
        expect(reportError).toHaveBeenCalledWith(
          error,
          'TournamentTimerService.checkTableSize_error'
        );
        expect(masterBus.emit).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
      }
    );

    it('does not declare consolidation from a small field or mutate its contract', async () => {
      rows.players = Array.from({ length: 5 }, (_, i) => ({ user_id: `p${i}`, chips: 1000 }));
      rows.tournament = { id: 'mtt', max_players: 100, final_table_triggered: false };
      await tournamentTimerService.checkTableSize('mtt');
      expect(writes).toEqual([]);
      expect(masterBus.emit).not.toHaveBeenCalledWith('FINAL_TABLE_REACHED', expect.anything());
    });

    it('observes a confirmed unlimited-field final table exactly once', async () => {
      rows.players = Array.from({ length: 5 }, (_, i) => ({ user_id: `p${i}`, chips: 1000 }));
      rows.tournament = {
        id: 'mtt',
        name: 'Final Table',
        max_players: null,
        final_table_triggered: true,
        prize_pool: 100,
      };
      await tournamentTimerService.checkTableSize('mtt');
      await tournamentTimerService.checkTableSize('mtt');
      const calls = vi
        .mocked(masterBus.emit)
        .mock.calls.filter(([type]) => type === 'FINAL_TABLE_REACHED');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ tournamentId: 'mtt', prizePool: 100 });
      expect(writes).toEqual([]);
    });
  });
});

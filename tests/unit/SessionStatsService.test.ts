/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SessionStatsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests in-memory session tracking logic:
 * - startSession: creates session with initial state
 * - recordHand: VPIP%, PFR%, P&L, bigBlindsWon, trajectory
 * - recordRebuy: adjusts buyInTotal and profitLoss
 * - endSession: returns final stats, clears session
 * - getStats / resetAll
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

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
    },
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { sessionStatsService } from '../../src/services/SessionStatsService';

describe('SessionStatsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    sessionStatsService.resetAll();
  });

  afterEach(() => {
    sessionStatsService.resetAll();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // START SESSION
  // ─────────────────────────────────────────────────────────────────────────

  describe('startSession', () => {
    it('should create session with initial values', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats).not.toBeNull();
      expect(stats!.initialStack).toBe(1000);
      expect(stats!.currentStack).toBe(1000);
      expect(stats!.bigBlind).toBe(10);
      expect(stats!.handsPlayed).toBe(0);
      expect(stats!.profitLoss).toBe(0);
    });

    it('should initialize trajectory with one data point', () => {
      sessionStatsService.startSession('table-1', 'user-1', 500, 5);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.trajectory.length).toBe(1);
      expect(stats!.trajectory[0][1]).toBe(500); // Initial stack
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RECORD HAND
  // ─────────────────────────────────────────────────────────────────────────

  describe('recordHand', () => {
    it('should increment hands played', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordHand('table-1', 1050, true, true, false);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.handsPlayed).toBe(1);
      expect(stats!.handsWon).toBe(1);
    });

    it('should calculate correct P&L', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordHand('table-1', 1200, true, false, false);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.profitLoss).toBe(200); // 1200 - 1000
      expect(stats!.bigBlindsWon).toBe(20); // 200 / 10
    });

    it('should calculate VPIP% correctly', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordHand('table-1', 1000, false, true, false); // vpip
      sessionStatsService.recordHand('table-1', 1000, false, false, false); // no vpip
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.vpipPercent).toBe(50); // 1 out of 2
    });

    it('should calculate PFR% correctly', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordHand('table-1', 1000, false, false, true); // pfr
      sessionStatsService.recordHand('table-1', 1000, false, false, false);
      sessionStatsService.recordHand('table-1', 1000, false, false, false);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.pfrPercent).toBe(33); // 1/3 = 33%
    });

    it('should handle zero bigBlind without crashing', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 0);
      sessionStatsService.recordHand('table-1', 1050, true, false, false);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.bigBlindsWon).toBe(0); // Safe divide by zero
    });

    it('should do nothing for unknown tableId', () => {
      sessionStatsService.recordHand('nonexistent', 500, true, true, true);
      expect(sessionStatsService.getStats('nonexistent')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RECORD REBUY
  // ─────────────────────────────────────────────────────────────────────────

  describe('recordRebuy', () => {
    it('should increase buyInTotal and adjust P&L', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordRebuy('table-1', 500);
      const stats = sessionStatsService.getStats('table-1');
      expect(stats!.buyInTotal).toBe(1500);
      expect(stats!.currentStack).toBe(1500);
      expect(stats!.profitLoss).toBe(0); // 1500 - 1500
    });

    it('should do nothing for unknown tableId', () => {
      sessionStatsService.recordRebuy('nonexistent', 500);
      expect(sessionStatsService.getStats('nonexistent')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // END SESSION
  // ─────────────────────────────────────────────────────────────────────────

  describe('endSession', () => {
    it('should return final stats and clear session', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.recordHand('table-1', 1200, true, true, true);
      const final = sessionStatsService.endSession('table-1');
      expect(final).not.toBeNull();
      expect(final!.profitLoss).toBe(200);
      expect(sessionStatsService.getStats('table-1')).toBeNull(); // Cleared
    });

    it('should return null for already-ended session', () => {
      expect(sessionStatsService.endSession('nonexistent')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RESET ALL
  // ─────────────────────────────────────────────────────────────────────────

  describe('resetAll', () => {
    it('should clear all sessions', () => {
      sessionStatsService.startSession('table-1', 'user-1', 1000, 10);
      sessionStatsService.startSession('table-2', 'user-2', 500, 5);
      sessionStatsService.resetAll();
      expect(sessionStatsService.getStats('table-1')).toBeNull();
      expect(sessionStatsService.getStats('table-2')).toBeNull();
    });
  });
});

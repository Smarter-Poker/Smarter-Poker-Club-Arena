/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HydraService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests DEFAULT_CONFIG, profile weights, getAdjustedWeights, getBetSize,
 * getDecision pure logic, and initialize config merge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    creditWallet: vi.fn().mockResolvedValue(undefined),
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// NOTE (2026-04-23, Phase U2): `vi.mock('../../src/engine/HorseLogic', ...)` removed —
// src/engine/HorseLogic no longer exists. HydraService now imports `HorseDecision` as
// a pure type from `src/types/engine/horse`, so nothing to mock at runtime.

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { HydraService } from '../../src/services/HydraService';
import type { HandContext, HorsePlayer } from '../../src/services/HydraService';

describe('HydraService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HydraService.initialize(); // Reset to defaults
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT CONFIG
  // ─────────────────────────────────────────────────────────────────────────

  describe('DEFAULT_CONFIG', () => {
    it('should have correct default fleet size (308)', () => {
      expect(HydraService.config.fleetSize).toBe(308);
    });

    it('should have maxHorsesPerTable = 4', () => {
      // Was 3; DEFAULT_CONFIG now seats up to 4 horses at a cash game table.
      expect(HydraService.config.maxHorsesPerTable).toBe(4);
    });

    it('should have minHorsesPerTable = 0', () => {
      expect(HydraService.config.minHorsesPerTable).toBe(0);
    });

    it('should have entryDelayRange [1, 3]', () => {
      // Was [10, 90] seconds; entry delay was tightened to [1, 3] so tables fill fast.
      expect(HydraService.config.entryDelayRange).toEqual([1, 3]);
    });

    it('should have organicRecedeEnabled = true', () => {
      expect(HydraService.config.organicRecedeEnabled).toBe(true);
    });

    it('should have seatWarmupDelay = 2000ms', () => {
      expect(HydraService.config.seatWarmupDelay).toBe(2000);
    });

    it('should have thinkTimeRange [800, 4000]', () => {
      expect(HydraService.config.thinkTimeRange).toEqual([800, 4000]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INITIALIZE
  // ─────────────────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should merge custom config with defaults', () => {
      HydraService.initialize({ fleetSize: 500, maxHorsesPerTable: 5 });
      expect(HydraService.config.fleetSize).toBe(500);
      expect(HydraService.config.maxHorsesPerTable).toBe(5);
      // Others remain default
      expect(HydraService.config.organicRecedeEnabled).toBe(true);
      expect(HydraService.config.seatWarmupDelay).toBe(2000);
      // Default entryDelayRange is [1, 3] (was [10, 90]) and survives the merge.
      expect(HydraService.config.entryDelayRange).toEqual([1, 3]);
    });

    it('should reset to defaults when called with no args', () => {
      HydraService.initialize({ fleetSize: 999 });
      HydraService.initialize();
      expect(HydraService.config.fleetSize).toBe(308);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET ADJUSTED WEIGHTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAdjustedWeights', () => {
    const baseContext: HandContext = {
      pot: 100,
      toCall: 20,
      minRaise: 40,
      maxRaise: 200,
      position: 'middle',
      street: 'flop',
      playersInHand: 3,
      stackToPotRatio: 10,
      isHeadsUp: false,
    };

    it('should return weights for all 5 profiles', () => {
      for (const profile of ['fish', 'reg', 'nit', 'lag', 'maniac'] as const) {
        const weights = HydraService.getAdjustedWeights(profile, baseContext);
        expect(weights).toBeDefined();
        expect(weights.fold).toBeGreaterThan(0);
        expect(weights.call).toBeGreaterThan(0);
      }
    });

    it('should increase aggression in late position', () => {
      const middle = HydraService.getAdjustedWeights('reg', { ...baseContext, position: 'middle' });
      const late = HydraService.getAdjustedWeights('reg', { ...baseContext, position: 'late' });
      expect(late.raise).toBeGreaterThan(middle.raise);
    });

    it('should increase fold in early position', () => {
      const middle = HydraService.getAdjustedWeights('reg', { ...baseContext, position: 'middle' });
      const early = HydraService.getAdjustedWeights('reg', { ...baseContext, position: 'early' });
      expect(early.fold).toBeGreaterThan(middle.fold);
    });

    it('should reduce fold heads-up', () => {
      const multi = HydraService.getAdjustedWeights('reg', { ...baseContext, isHeadsUp: false });
      const hu = HydraService.getAdjustedWeights('reg', { ...baseContext, isHeadsUp: true });
      expect(hu.fold).toBeLessThan(multi.fold);
    });

    it('should boost all-in with low SPR', () => {
      const highSPR = HydraService.getAdjustedWeights('reg', {
        ...baseContext,
        stackToPotRatio: 10,
      });
      const lowSPR = HydraService.getAdjustedWeights('reg', { ...baseContext, stackToPotRatio: 2 });
      expect(lowSPR.all_in).toBeGreaterThan(highSPR.all_in);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET BET SIZE
  // ─────────────────────────────────────────────────────────────────────────

  describe('getBetSize', () => {
    const betContext: HandContext = {
      pot: 100,
      toCall: 20,
      minRaise: 40,
      maxRaise: 500,
      position: 'middle',
      street: 'flop',
      playersInHand: 3,
      stackToPotRatio: 10,
      isHeadsUp: false,
    };

    it('should return a value within minRaise and maxRaise', () => {
      for (let i = 0; i < 20; i++) {
        const size = HydraService.getBetSize('reg', betContext);
        expect(size).toBeGreaterThanOrEqual(betContext.minRaise);
        expect(size).toBeLessThanOrEqual(betContext.maxRaise);
      }
    });

    it('should produce larger bets for maniac vs nit', () => {
      // Run multiple times to get average
      let maniacTotal = 0;
      let nitTotal = 0;
      const runs = 100;
      for (let i = 0; i < runs; i++) {
        maniacTotal += HydraService.getBetSize('maniac', betContext);
        nitTotal += HydraService.getBetSize('nit', betContext);
      }
      expect(maniacTotal / runs).toBeGreaterThan(nitTotal / runs);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET DECISION
  // ─────────────────────────────────────────────────────────────────────────

  describe('getDecision', () => {
    const horse: HorsePlayer = {
      id: 'h-1',
      name: 'Test Horse',
      playerNumber: 101,
      avatar: '',
      profile: 'reg',
      stack: 500,
      seatNumber: 1,
      status: 'seated',
      tableId: 't-1',
      joinedAt: new Date().toISOString(),
      leavingAfterOrbit: false,
      handsPlayed: 0,
      orbitsPlayed: 0,
    };

    const context: HandContext = {
      pot: 100,
      toCall: 20,
      minRaise: 40,
      maxRaise: 200,
      position: 'middle',
      street: 'flop',
      playersInHand: 3,
      stackToPotRatio: 5,
      isHeadsUp: false,
    };

    it('should return a valid action', () => {
      const validActions = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
      for (let i = 0; i < 20; i++) {
        const decision = HydraService.getDecision(horse, context);
        expect(validActions).toContain(decision.action);
      }
    });

    it('should include thinkTime in result', () => {
      const decision = HydraService.getDecision(horse, context);
      expect(decision.thinkTime).toBeGreaterThan(0);
    });

    it('should return decision object with expected shape', () => {
      for (let i = 0; i < 20; i++) {
        const decision = HydraService.getDecision(horse, context);
        expect(decision).toHaveProperty('action');
        expect(decision).toHaveProperty('thinkTime');
        // amount may be undefined for fold/check
        if (['bet', 'raise', 'all_in'].includes(decision.action) && decision.amount !== undefined) {
          expect(typeof decision.amount).toBe('number');
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FLEET QUERIES (mocked → empty)
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAvailableHorses', () => {
    it('should return empty array when no horses available', async () => {
      const result = await HydraService.getAvailableHorses();
      expect(result).toEqual([]);
    });
  });

  describe('getActiveHorses', () => {
    it('should return empty array when no seats at table', async () => {
      const result = await HydraService.getActiveHorses('table-1');
      expect(result).toEqual([]);
    });
  });
});

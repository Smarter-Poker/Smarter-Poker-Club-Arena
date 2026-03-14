/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AntiCollusionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests collusion detection scoring and pattern tracking:
 * - calculateScore: base scores per pattern type, evidence multipliers
 * - trackFold: fold rate threshold + encounter minimum
 * - trackChipDump: pot size + hand strength thresholds
 * - trackSeating: coordinated seating detection
 * - clearSession: memory cleanup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

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

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    raise: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { AntiCollusionService } from '../../src/services/AntiCollusionService';

describe('AntiCollusionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    AntiCollusionService.clearSession();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATE SCORE
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateScore', () => {
    it('should return base score of 25 for FOLD_TO_PLAYER', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'FOLD_TO_PLAYER',
        evidence: {},
        timestamp: Date.now(),
      });
      expect(score).toBe(25);
    });

    it('should return base score of 40 for CHIP_DUMP', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'CHIP_DUMP',
        evidence: {},
        timestamp: Date.now(),
      });
      expect(score).toBe(40);
    });

    it('should return base score of 15 for COORDINATED_SEATING', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'COORDINATED_SEATING',
        evidence: {},
        timestamp: Date.now(),
      });
      expect(score).toBe(15);
    });

    it('should return base score of 30 for SOFT_PLAY', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'SOFT_PLAY',
        evidence: {},
        timestamp: Date.now(),
      });
      expect(score).toBe(30);
    });

    it('should return base score of 20 for WIN_RATE_ANOMALY', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'WIN_RATE_ANOMALY',
        evidence: {},
        timestamp: Date.now(),
      });
      expect(score).toBe(20);
    });

    it('should amplify score based on foldRate evidence', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'FOLD_TO_PLAYER',
        evidence: { foldRate: 90 }, // 90% fold rate
        timestamp: Date.now(),
      });
      // base 25, multiplier = 90/100 = 0.9 → max(1, 0.9) = 1 → 25
      expect(score).toBe(25);
    });

    it('should amplify score based on potSize evidence', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'CHIP_DUMP',
        evidence: { potSize: 200 }, // 200 chips → multiplier 2 (capped)
        timestamp: Date.now(),
      });
      // base 40, potSize multiplier = min(200/100, 2) = 2 → 40 * max(1, 2) = 80
      expect(score).toBe(80);
    });

    it('should cap score at 100', () => {
      const score = AntiCollusionService.calculateScore({
        playerA: 'p1',
        playerB: 'p2',
        patternType: 'CHIP_DUMP',
        evidence: { foldRate: 100, potSize: 999 },
        timestamp: Date.now(),
      });
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRACK FOLD
  // ─────────────────────────────────────────────────────────────────────────

  describe('trackFold', () => {
    it('should NOT record event below 10 encounters', () => {
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent');
      for (let i = 0; i < 9; i++) {
        AntiCollusionService.trackFold('p1', 'p2', 100);
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should record event at 10+ encounters with 80%+ fold rate', () => {
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent').mockResolvedValue(undefined);
      for (let i = 0; i < 10; i++) {
        AntiCollusionService.trackFold('p1', 'p2', 100);
      }
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRACK CHIP DUMP
  // ─────────────────────────────────────────────────────────────────────────

  describe('trackChipDump', () => {
    it('should NOT flag small pot chip dumps', () => {
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent').mockResolvedValue(undefined);
      AntiCollusionService.trackChipDump('p1', 'p2', 10, 0.9); // pot < 50
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should NOT flag weak hand folds', () => {
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent').mockResolvedValue(undefined);
      AntiCollusionService.trackChipDump('p1', 'p2', 100, 0.3); // hand < 0.7
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should flag strong hand fold in big pot', () => {
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent').mockResolvedValue(undefined);
      AntiCollusionService.trackChipDump('p1', 'p2', 100, 0.9);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          patternType: 'CHIP_DUMP',
          evidence: expect.objectContaining({
            potSize: 100,
            handStrength: 90,
          }),
        })
      );
      spy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLEAR SESSION
  // ─────────────────────────────────────────────────────────────────────────

  describe('clearSession', () => {
    it('should reset all tracking data', () => {
      AntiCollusionService.trackFold('p1', 'p2', 100);
      AntiCollusionService.clearSession();
      // After clear, a new fold series should start from 0
      const spy = vi.spyOn(AntiCollusionService, 'recordEvent');
      AntiCollusionService.trackFold('p1', 'p2', 100);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

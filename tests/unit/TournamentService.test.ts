/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TournamentService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests BLIND_STRUCTURES, PAYOUT_STRUCTURES, SPIN_MULTIPLIERS, BOUNTY_PRESETS,
 * getTournament null return, and getTournaments empty return.
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
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { logTransaction: vi.fn().mockResolvedValue(undefined) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
  SPIN_MULTIPLIERS,
  BOUNTY_PRESETS,
  SPIN_BLIND_STRUCTURE,
  tournamentService,
} from '../../src/services/TournamentService';

describe('TournamentService', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // BLIND STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('BLIND_STRUCTURES', () => {
    it('should have turbo, regular, and deepStack', () => {
      expect(BLIND_STRUCTURES.turbo).toBeDefined();
      expect(BLIND_STRUCTURES.regular).toBeDefined();
      expect(BLIND_STRUCTURES.deepStack).toBeDefined();
    });

    it('turbo should have 30 levels', () => {
      expect(BLIND_STRUCTURES.turbo).toHaveLength(30);
      // Check durations (3m or 5m break periods)
      const turboLevels = BLIND_STRUCTURES.turbo;
      for (const lvl of turboLevels) {
        expect([3, 5]).toContain(lvl.durationMinutes);
      }
    });

    it('regular should have 30 levels', () => {
      expect(BLIND_STRUCTURES.regular).toHaveLength(30);
      const regularLevels = BLIND_STRUCTURES.regular;
      for (const lvl of regularLevels) {
        expect([5, 8]).toContain(lvl.durationMinutes);
      }
    });

    it('deepStack should have 30 levels', () => {
      expect(BLIND_STRUCTURES.deepStack).toHaveLength(30);
      const deepStackLevels = BLIND_STRUCTURES.deepStack;
      for (const lvl of deepStackLevels) {
        expect([5, 15]).toContain(lvl.durationMinutes);
      }
    });

    it('blinds should increase monotonically per structure (excluding break levels)', () => {
      for (const struct of Object.values(BLIND_STRUCTURES)) {
        for (let i = 1; i < struct.length; i++) {
          // Breaks have 0 blinds, so skip comparisons involving breaks
          if (!struct[i].isBreak && !struct[i - 1].isBreak) {
            expect(struct[i].bigBlind).toBeGreaterThanOrEqual(struct[i - 1].bigBlind);
          }
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PAYOUT STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('PAYOUT_STRUCTURES', () => {
    it('should have sng6, sng9, mtt10, mtt20, mtt50', () => {
      expect(PAYOUT_STRUCTURES.sng6).toBeDefined();
      expect(PAYOUT_STRUCTURES.sng9).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt10).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt20).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt50).toBeDefined();
    });

    it('each structure should sum to 100%', () => {
      for (const [name, struct] of Object.entries(PAYOUT_STRUCTURES)) {
        const total = struct.reduce((sum, p) => sum + p.percentage, 0);
        expect(total).toBeCloseTo(100, 1);
      }
    });

    it('sng6 should pay 2 places', () => {
      expect(PAYOUT_STRUCTURES.sng6).toHaveLength(2);
    });

    it('sng9 should pay 3 places', () => {
      expect(PAYOUT_STRUCTURES.sng9).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN MULTIPLIERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_MULTIPLIERS', () => {
    it('should have standard and hyper profiles', () => {
      expect(SPIN_MULTIPLIERS.standard).toBeDefined();
      expect(SPIN_MULTIPLIERS.hyper).toBeDefined();
    });

    it('standard probabilities should sum to ≈100%', () => {
      const total = SPIN_MULTIPLIERS.standard.reduce((sum, s) => sum + s.probability, 0);
      expect(total).toBeCloseTo(100, 0);
    });

    it('standard EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.standard.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });

    it('hyper EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.hyper.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BOUNTY PRESETS
  // ─────────────────────────────────────────────────────────────────────────

  describe('BOUNTY_PRESETS', () => {
    it('should have fixed, progressive, mystery', () => {
      expect(BOUNTY_PRESETS.fixed).toBeDefined();
      expect(BOUNTY_PRESETS.progressive).toBeDefined();
      expect(BOUNTY_PRESETS.mystery).toBeDefined();
    });

    it('fixed should have bountyType = fixed', () => {
      expect(BOUNTY_PRESETS.fixed.bountyType).toBe('fixed');
    });

    it('mystery should have mysteryTiers array', () => {
      expect(BOUNTY_PRESETS.mystery.mysteryTiers).toBeDefined();
      expect(BOUNTY_PRESETS.mystery.mysteryTiers!.length).toBeGreaterThan(0);
    });

    it('mystery tier probabilities should sum to ≈100%', () => {
      const total = BOUNTY_PRESETS.mystery.mysteryTiers!.reduce((s, t) => s + t.probability, 0);
      expect(total).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN BLIND STRUCTURE
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_BLIND_STRUCTURE', () => {
    it('should have 15 levels at 2m each', () => {
      expect(SPIN_BLIND_STRUCTURE).toHaveLength(15);
      for (const lvl of SPIN_BLIND_STRUCTURE) {
        expect(lvl.durationMinutes).toBe(2);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTournament', () => {
    it('should return null when tournament not found', async () => {
      const result = await tournamentService.getTournament('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getTournaments', () => {
    it('should return empty array when no tournaments', async () => {
      const result = await tournamentService.getTournaments('club-1');
      expect(result).toEqual([]);
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PayoutEngine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests tournament payout calculation logic:
 * - calculateAmounts: prize pool × percentage → chip amounts
 * - normalizePayouts: percentages sum to exactly 100%
 * - calculateICM: Malmuth-Harville chip equity model
 * - getOverlayStatus: guaranteed vs entries overlay detection
 * - generatePayouts: template-based payout generation
 * - autoSelectPayouts: player count → best template selection
 * - getTemplateOptions: all available template metadata
 * - getRemainingPayouts: remaining positions with amounts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/services/TournamentService', () => ({
  PAYOUT_STRUCTURES: {
    sng6: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
    sng9: [
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ],
    mtt10: [
      { place: 1, percentage: 40 },
      { place: 2, percentage: 25 },
      { place: 3, percentage: 15 },
      { place: 4, percentage: 10 },
      { place: 5, percentage: 10 },
    ],
    mtt20: null,
    mtt50: null,
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { payoutEngine } from '../../src/services/PayoutEngine';

describe('PayoutEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATE AMOUNTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateAmounts', () => {
    it('should multiply percentages by prize pool', () => {
      const payouts = [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ];
      const result = payoutEngine.calculateAmounts(payouts, 10000);
      expect(result[0].amount).toBe(5000);
      expect(result[1].amount).toBe(3000);
      expect(result[2].amount).toBe(2000);
    });

    it('pays out the whole pool, even when the structure does not sum to 100', () => {
      /* 2026-08-29: this pinned truncation -- one place at 33.33% of a 100 pool
         paid 33.33 and left 66.67 of collected buy-ins allocated to nobody.
         calculateAmounts now uses the one payout rule (src/lib/payoutMath.ts,
         byte-identical to the engine's), which normalises a malformed
         structure to 100% instead of silently stranding the rest. A single
         listed place is also the LAST place, so it takes the residual: the
         whole pool. Replaced in the same commit that shipped the change. */
      const payouts = [{ place: 1, percentage: 33.33 }];
      const result = payoutEngine.calculateAmounts(payouts, 100);
      expect(result[0].amount).toBe(100);
    });

    it('never lets the amounts exceed the pool, and never shaves first place', () => {
      /* The old fallback trimmed any excess off amounts[0] -- the headline
         prize. The engine's rule puts an adjustment on the SMALLEST prize, on
         purpose, and the places cannot exceed the pool by construction. */
      const payouts = [
        { place: 1, percentage: 90 },
        { place: 2, percentage: 80 },
        { place: 3, percentage: 70 },
      ];
      const result = payoutEngine.calculateAmounts(payouts, 100);
      const total = result.reduce((s, a) => s + Math.round((a.amount ?? 0) * 100), 0);
      expect(total).toBe(10000);
      expect(result.every((a) => (a.amount ?? 0) >= 0)).toBe(true);
      expect(result[0].amount).toBe(37.5); // its own normalised share, untouched
    });

    it('should handle zero prize pool', () => {
      const payouts = [{ place: 1, percentage: 100 }];
      const result = payoutEngine.calculateAmounts(payouts, 0);
      expect(result[0].amount).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NORMALIZE PAYOUTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('normalizePayouts', () => {
    it('should return payouts unchanged if already 100%', () => {
      const payouts = [
        { place: 1, percentage: 60 },
        { place: 2, percentage: 40 },
      ];
      const result = payoutEngine.normalizePayouts(payouts);
      expect(result[0].percentage).toBe(60);
      expect(result[1].percentage).toBe(40);
    });

    it('should scale payouts that exceed 100%', () => {
      const payouts = [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 60 },
      ];
      const result = payoutEngine.normalizePayouts(payouts);
      const total = result.reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.1);
    });

    it('should scale payouts below 100%', () => {
      const payouts = [
        { place: 1, percentage: 30 },
        { place: 2, percentage: 20 },
      ];
      const result = payoutEngine.normalizePayouts(payouts);
      const total = result.reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATE ICM
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateICM', () => {
    it('should calculate equity proportional to chip stacks', () => {
      const players = [
        { userId: 'p1', chips: 7000 },
        { userId: 'p2', chips: 3000 },
      ];
      const payouts = [
        { place: 1, percentage: 65 },
        { place: 2, percentage: 35 },
      ];
      const result = payoutEngine.calculateICM(players, payouts, 10000);
      expect(result.length).toBe(2);

      // Chip leader should have more equity
      const p1 = result.find((r) => r.userId === 'p1')!;
      const p2 = result.find((r) => r.userId === 'p2')!;
      expect(p1.icmEquity).toBeGreaterThan(p2.icmEquity);
    });

    it('should normalize total ICM to prize pool', () => {
      const players = [
        { userId: 'a', chips: 5000 },
        { userId: 'b', chips: 3000 },
        { userId: 'c', chips: 2000 },
      ];
      const payouts = [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ];
      const result = payoutEngine.calculateICM(players, payouts, 9000);
      const totalICM = result.reduce((s, r) => s + r.icmEquity, 0);
      expect(Math.abs(totalICM - 9000)).toBeLessThan(1); // Allow rounding
    });

    it('should return empty array for zero total chips', () => {
      const result = payoutEngine.calculateICM(
        [{ userId: 'x', chips: 0 }],
        [{ place: 1, percentage: 100 }],
        1000
      );
      expect(result).toEqual([]);
    });

    it('should sort results by chip count descending', () => {
      const players = [
        { userId: 'a', chips: 1000 },
        { userId: 'b', chips: 5000 },
        { userId: 'c', chips: 3000 },
      ];
      const payouts = [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ];
      const result = payoutEngine.calculateICM(players, payouts, 9000);
      expect(result[0].userId).toBe('b'); // Most chips first
      expect(result[2].userId).toBe('a'); // Fewest chips last
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET OVERLAY STATUS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getOverlayStatus', () => {
    it('should detect overlay when guarantee exceeds entries', () => {
      const result = payoutEngine.getOverlayStatus(10000, 8, 1000);
      expect(result.hasOverlay).toBe(true);
      expect(result.overlayAmount).toBe(2000);
      expect(result.entriesPrize).toBe(8000);
    });

    it('should report no overlay when entries exceed guarantee', () => {
      const result = payoutEngine.getOverlayStatus(5000, 10, 1000);
      expect(result.hasOverlay).toBe(false);
      expect(result.overlayAmount).toBe(0);
    });

    it('should report no overlay when exactly matched', () => {
      const result = payoutEngine.getOverlayStatus(10000, 10, 1000);
      expect(result.hasOverlay).toBe(false);
      expect(result.overlayAmount).toBe(0);
    });

    it('should handle 100% overlay (zero entries)', () => {
      const result = payoutEngine.getOverlayStatus(5000, 0, 100);
      expect(result.hasOverlay).toBe(true);
      expect(result.overlayPercentage).toBe(100);
    });

    it('reports no overlay, and never NaN, when there is no guarantee', () => {
      // The percentage used to divide by guaranteedPrize behind an
      // `entriesPrize > 0` guard, so this returned NaN; with zero entries it
      // claimed a 100% overlay on a guarantee that does not exist.
      const withEntries = payoutEngine.getOverlayStatus(0, 8, 1000);
      expect(withEntries.hasOverlay).toBe(false);
      expect(Number.isNaN(withEntries.overlayPercentage)).toBe(false);
      expect(withEntries.overlayPercentage).toBe(0);

      const noEntries = payoutEngine.getOverlayStatus(0, 0, 1000);
      expect(noEntries.hasOverlay).toBe(false);
      expect(noEntries.overlayPercentage).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GENERATE PAYOUTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('generatePayouts', () => {
    it('should return winner-take-all template', () => {
      const result = payoutEngine.generatePayouts('winner_take_all', 10);
      expect(result.length).toBe(1);
      expect(result[0].percentage).toBe(100);
    });

    it('should return 50/30/20 template', () => {
      const result = payoutEngine.generatePayouts('50_30_20', 10);
      expect(result.length).toBe(3);
      expect(result[0].percentage).toBe(50);
      expect(result[1].percentage).toBe(30);
      expect(result[2].percentage).toBe(20);
    });

    it('should use custom payouts when provided', () => {
      const custom = [
        { place: 1, percentage: 70 },
        { place: 2, percentage: 30 },
      ];
      const result = payoutEngine.generatePayouts('custom', 10, custom);
      expect(result.length).toBe(2);
    });

    it('should generate dynamic top15 payouts based on player count', () => {
      const result = payoutEngine.generatePayouts('top15', 100);
      // 15 players should be paid (15% of 100)
      expect(result.length).toBe(15);
      // Percentages should sum to ~100
      const total = result.reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.1);
    });

    it('should generate dynamic top20 payouts based on player count', () => {
      const result = payoutEngine.generatePayouts('top20', 50);
      // 10 players should be paid (20% of 50)
      expect(result.length).toBe(10);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AUTO SELECT PAYOUTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('autoSelectPayouts', () => {
    it('should select sng3 for 3 or fewer players', () => {
      const result = payoutEngine.autoSelectPayouts(3);
      expect(result.length).toBe(2); // sng3 is 65/35
    });

    it('should select sng6 for 4-6 players', () => {
      const result = payoutEngine.autoSelectPayouts(6);
      expect(result.length).toBe(2); // sng6 is 65/35
    });

    it('should select sng9 for 7-9 players', () => {
      const result = payoutEngine.autoSelectPayouts(9);
      expect(result.length).toBe(3); // sng9 is 50/30/20
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PAYOUTS FOR CHOICE (PokerBros parity, 2026-08-22)
  // ─────────────────────────────────────────────────────────────────────────

  describe('payoutsForChoice', () => {
    it('pays ~10/15/20% of the field for payout1/2/3', () => {
      expect(payoutEngine.payoutsForChoice('payout1', 100).length).toBe(10);
      expect(payoutEngine.payoutsForChoice('payout2', 100).length).toBe(15);
      expect(payoutEngine.payoutsForChoice('payout3', 100).length).toBe(20);
    });

    it('winner_take_all is exactly one place at 100%', () => {
      expect(payoutEngine.payoutsForChoice('winner_take_all', 100)).toEqual([
        { place: 1, percentage: 100 },
      ]);
    });

    it('always totals 100 and never pays a place nobody can reach', () => {
      /*
       * WAS `toBeLessThan(n)` (2026-08-31). It pinned `Math.min(n - 1, ...)`,
       * and that clamp was not a rule - it was a workaround for
       * `fn_create_tournament` refusing `paid_places >= max_players`, itself an
       * off-by-one corrected in PR #2334. The real rule is that a ladder cannot
       * pay a seat that does not exist, which is `<= n`.
       */
      for (const choice of ['payout1', 'payout2', 'payout3']) {
        for (const n of [2, 3, 4, 9, 27, 500]) {
          const payouts = payoutEngine.payoutsForChoice(choice, n);
          const total = payouts.reduce((s, p) => s + p.percentage, 0);
          expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
          expect(payouts.length).toBeGreaterThanOrEqual(1);
          expect(payouts.length).toBeLessThanOrEqual(n);
        }
      }
    });

    it('honours minPlaces on a field too short for the old clamp', () => {
      // payout3 declares minPlaces 3 and used to return 2 at a 3-seat field;
      // payout2 declares minPlaces 2 and used to collapse to winner-take-all
      // heads-up, so a 65/35 heads-up SNG could not be expressed at all.
      expect(payoutEngine.payoutsForChoice('payout3', 3).length).toBe(3);
      expect(payoutEngine.payoutsForChoice('payout2', 2).length).toBe(2);
    });

    it('payout1 is more top-heavy than payout3 on the same field', () => {
      const first = (choice: string) => payoutEngine.payoutsForChoice(choice, 100)[0].percentage;
      expect(first('payout1')).toBeGreaterThan(first('payout3'));
    });

    it('unknown choices fall back to payout1', () => {
      expect(payoutEngine.payoutsForChoice('nonsense', 100).length).toBe(
        payoutEngine.payoutsForChoice('payout1', 100).length
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET TEMPLATE OPTIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTemplateOptions', () => {
    it('should return 8 template options', () => {
      const options = payoutEngine.getTemplateOptions();
      expect(options.length).toBe(8);
    });

    it('should include winner_take_all', () => {
      const options = payoutEngine.getTemplateOptions();
      expect(options.find((o) => o.value === 'winner_take_all')).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET REMAINING PAYOUTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRemainingPayouts', () => {
    it('should filter to only positions <= playersRemaining', () => {
      const payouts = [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ];
      const result = payoutEngine.getRemainingPayouts(payouts, 2, 10, 10000);
      expect(result.length).toBe(2); // Only places 1 and 2
      expect(result[0].amount).toBeDefined();
    });
  });
});

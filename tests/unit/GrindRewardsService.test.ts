/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — GrindRewardsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests milestone catalog integrity, rake race reward tiers, and the
 * tournament points formula (sqrt, pow, log10 scaling).
 *
 * MILESTONE catalog: 15 entries across 4 categories
 * RAKE_RACE_REWARDS: 6 tiers (1st=500, 2nd=300, 3rd=150, 4-5=75/50, 6-10=25)
 * TOURNAMENT_POINT_FORMULAS.calculatePoints: verified with precise math
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { grindRewardsService, MILESTONES } from '../../src/services/GrindRewardsService';
import { masterBus } from '../../src/core/MasterBus';

describe('GrindRewardsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MILESTONE CATALOG INTEGRITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('MILESTONES', () => {
    it('should contain exactly 15 milestones', () => {
      expect(MILESTONES.length).toBe(15);
    });

    it('should have unique IDs', () => {
      const ids = MILESTONES.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have positive requirements and rewards', () => {
      for (const m of MILESTONES) {
        expect(m.requirement).toBeGreaterThan(0);
        expect(m.rewardDiamonds).toBeGreaterThan(0);
      }
    });

    it('should have valid categories', () => {
      const validCategories = ['hands', 'wins', 'tournaments', 'achievement'];
      for (const m of MILESTONES) {
        expect(validCategories).toContain(m.category);
      }
    });

    it('should have 5 hands milestones', () => {
      const hands = MILESTONES.filter((m) => m.category === 'hands');
      expect(hands.length).toBe(5);
    });

    it('should have 3 wins milestones', () => {
      const wins = MILESTONES.filter((m) => m.category === 'wins');
      expect(wins.length).toBe(3);
    });

    it('should have 5 tournament milestones', () => {
      const tournaments = MILESTONES.filter((m) => m.category === 'tournaments');
      expect(tournaments.length).toBe(5);
    });

    it('should have 2 achievement milestones', () => {
      const achievements = MILESTONES.filter((m) => m.category === 'achievement');
      expect(achievements.length).toBe(2);
    });

    it('should have ascending requirements within hands category', () => {
      const hands = MILESTONES.filter((m) => m.category === 'hands');
      for (let i = 1; i < hands.length; i++) {
        expect(hands[i].requirement).toBeGreaterThan(hands[i - 1].requirement);
      }
    });

    it('should have ascending rewards within hands category', () => {
      const hands = MILESTONES.filter((m) => m.category === 'hands');
      for (let i = 1; i < hands.length; i++) {
        expect(hands[i].rewardDiamonds).toBeGreaterThan(hands[i - 1].rewardDiamonds);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK MILESTONE
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkMilestone', () => {
    it('should return true when value meets requirement', () => {
      const milestone = MILESTONES[0]; // hands_100, requirement = 100
      expect(grindRewardsService.checkMilestone(milestone, 100)).toBe(true);
    });

    it('should return true when value exceeds requirement', () => {
      const milestone = MILESTONES[0];
      expect(grindRewardsService.checkMilestone(milestone, 999)).toBe(true);
    });

    it('should return false when value is below requirement', () => {
      const milestone = MILESTONES[0];
      expect(grindRewardsService.checkMilestone(milestone, 99)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAKE RACE REWARD TIERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRakeRaceReward', () => {
    it('should return 500 diamonds for rank 1', () => {
      expect(grindRewardsService.getRakeRaceReward(1)).toBe(500);
    });

    it('should return 300 diamonds for rank 2', () => {
      expect(grindRewardsService.getRakeRaceReward(2)).toBe(300);
    });

    it('should return 150 diamonds for rank 3', () => {
      expect(grindRewardsService.getRakeRaceReward(3)).toBe(150);
    });

    it('should return 75 diamonds for rank 4', () => {
      expect(grindRewardsService.getRakeRaceReward(4)).toBe(75);
    });

    it('should return 50 diamonds for rank 5', () => {
      expect(grindRewardsService.getRakeRaceReward(5)).toBe(50);
    });

    it('should return 25 diamonds for ranks 6-10', () => {
      expect(grindRewardsService.getRakeRaceReward(6)).toBe(25);
      expect(grindRewardsService.getRakeRaceReward(10)).toBe(25);
    });

    it('should return 0 for ranks outside top 10', () => {
      expect(grindRewardsService.getRakeRaceReward(11)).toBe(0);
      expect(grindRewardsService.getRakeRaceReward(100)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT POINTS FORMULA
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateTournamentPoints', () => {
    it('should return 0 for invalid position (0 or negative)', () => {
      expect(grindRewardsService.calculateTournamentPoints(100, 0, 500)).toBe(0);
      expect(grindRewardsService.calculateTournamentPoints(100, -1, 500)).toBe(0);
    });

    it('should return 0 for position beyond total players', () => {
      expect(grindRewardsService.calculateTournamentPoints(10, 11, 500)).toBe(0);
    });

    it('should give 1st place more points than 2nd place', () => {
      const first = grindRewardsService.calculateTournamentPoints(100, 1, 500);
      const second = grindRewardsService.calculateTournamentPoints(100, 2, 500);
      expect(first).toBeGreaterThan(second);
    });

    it('should give more points for larger fields', () => {
      const small = grindRewardsService.calculateTournamentPoints(10, 1, 500);
      const large = grindRewardsService.calculateTournamentPoints(1000, 1, 500);
      expect(large).toBeGreaterThan(small);
    });

    it('should give more points for higher buy-ins (log scale)', () => {
      const low = grindRewardsService.calculateTournamentPoints(100, 1, 10);
      const high = grindRewardsService.calculateTournamentPoints(100, 1, 10000);
      expect(high).toBeGreaterThan(low);
    });

    it('should compute 1st/100 players/$500 buy-in precisely', () => {
      // fieldBonus = sqrt(100) * 10 = 100
      // positionRatio = 1 - 0/100 = 1.0
      // positionMultiplier = pow(1.0, 1.5) = 1.0
      // buyInWeight = max(1, log10(501)) = max(1, 2.6998) = 2.6998
      // winBonus = 20, finalTableBonus = 10 (1 <= max(9, 10))
      // total = round((100 * 1.0 * 2.6998 + 20 + 10) * 100) / 100
      const result = grindRewardsService.calculateTournamentPoints(100, 1, 500);
      const expected =
        Math.round(
          (Math.sqrt(100) * 10 * Math.pow(1, 1.5) * Math.max(1, Math.log10(501)) + 20 + 10) * 100
        ) / 100;
      expect(result).toBe(expected);
    });

    it('should compute last place with minimal points', () => {
      // Last place: positionRatio = 1 - 99/100 = 0.01
      // positionMultiplier = pow(0.01, 1.5) ≈ 0.001
      // buyInWeight = log10(501) ≈ 2.6998
      // winBonus = 0, finalTableBonus = 0
      // total = round((100 * 0.001 * 2.6998 + 0 + 0) * 100) / 100
      const result = grindRewardsService.calculateTournamentPoints(100, 100, 500);
      const expected =
        Math.round(
          (Math.sqrt(100) * 10 * Math.pow(1 - 99 / 100, 1.5) * Math.max(1, Math.log10(501)) +
            0 +
            0) *
            100
        ) / 100;
      expect(result).toBe(expected);
      expect(result).toBeGreaterThan(0); // Non-zero due to positionRatio = 0.01
      expect(result).toBeLessThan(1); // But very small
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EMIT MILESTONE UNLOCKED
  // ─────────────────────────────────────────────────────────────────────────

  describe('emitMilestoneUnlocked', () => {
    it('should emit MILESTONE_UNLOCKED event with correct payload', () => {
      const milestone = MILESTONES[0]; // hands_100
      grindRewardsService.emitMilestoneUnlocked('user-1', milestone);
      expect(masterBus.emit).toHaveBeenCalledWith('MILESTONE_UNLOCKED', {
        userId: 'user-1',
        milestoneId: 'hands_100',
        milestoneName: 'Card Shark',
        icon: '🃏',
        rewardDiamonds: 5,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAKE RACE TIERS LIST
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRakeRaceTiers', () => {
    it('should return 6 tiers', () => {
      expect(grindRewardsService.getRakeRaceTiers().length).toBe(6);
    });

    it('should have descending diamond rewards', () => {
      const tiers = grindRewardsService.getRakeRaceTiers();
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i].diamonds).toBeLessThanOrEqual(tiers[i - 1].diamonds);
      }
    });
  });
});

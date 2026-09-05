/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DailyChallengeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the CHALLENGE_POOL catalog and pure utility logic.
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

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  CHALLENGE_TYPES,
  CHALLENGE_POOL,
  WEEKLY_CHALLENGE_POOL,
  MONTHLY_CHALLENGE_POOL,
  MAGNITUDE_TYPES,
  handRankScore,
  isStrongHand,
} from '../../src/services/DailyChallengeService';

describe('DailyChallengeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CHALLENGE POOL INTEGRITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('CHALLENGE_POOL', () => {
    it('should contain at least 11 daily challenges', () => {
      expect(CHALLENGE_POOL.length).toBeGreaterThanOrEqual(11);
    });

    it('should have unique IDs', () => {
      const ids = CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have positive requirements and a meaningful reward', () => {
      // Dan 2026-09-05: a reward is diamonds, never chips. `chipReward` was
      // removed from the pool entirely (migration 20260905114421 stopped the
      // three RPCs crediting it), so "pays something" is now one number.
      for (const c of CHALLENGE_POOL) {
        expect(c.requirement).toBeGreaterThan(0);
        expect(c.diamondReward).toBeGreaterThan(0);
      }
    });

    // Derived from CHALLENGE_TYPES, never hand-copied. The previous version
    // duplicated the list here and drifted: big_pots and strong_hands were live
    // in production while this test still asserted against a list that predated
    // them, so it failed on correct code and would have passed on a type nobody
    // could increment.
    it('should have valid challenge types', () => {
      for (const c of [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL]) {
        expect(CHALLENGE_TYPES as readonly string[]).toContain(c.type);
      }
    });

    // Every assignable challenge must be winnable. A type with no writer means
    // a card that can be handed out and never moves.
    it('every pool type has something in the app that increments it', () => {
      const WRITTEN_BY_APP: Record<string, string> = {
        hands_played: 'AchievementTriggerService.onHandComplete',
        hands_won: 'AchievementTriggerService.onHandComplete',
        showdowns: 'AchievementTriggerService.onHandComplete',
        showdowns_won: 'AchievementTriggerService.onHandComplete',
        hands_won_no_showdown: 'AchievementTriggerService.onHandComplete',
        big_pots: 'AchievementTriggerService.onHandComplete',
        strong_hands: 'AchievementTriggerService.onHandComplete',
        chips_won: 'AchievementTriggerService.onHandComplete',
        tournaments_played: 'AchievementTriggerService TOURNAMENT_REGISTERED subscriber',
        friends_added: 'AchievementTriggerService.onFriendAdded',
      };
      for (const c of [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL]) {
        expect(
          WRITTEN_BY_APP[c.type],
          `challenge "${c.id}" has type "${c.type}", which nothing increments -- it could never be completed`
        ).toBeTruthy();
      }
      // And no declared type is dead weight waiting to be used by mistake.
      for (const t of CHALLENGE_TYPES) {
        expect(WRITTEN_BY_APP[t], `challenge type "${t}" has no writer in the app`).toBeTruthy();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  SPECIFICITY  (Dan 2026-08-21)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // "COME UP WITH SPECIFIC CHALLENGES, DO NOT USE GENERIC 'BIG POT 4' WIN 4
  // BIG POTS SMH ITS NOT EVEN SPECIFIED HOW MUCH A BIG POT IS."
  //
  // These tests exist so that instruction cannot be quietly undone by a later
  // edit that adds a vague entry back into the pool.
  describe('challenge descriptions are self-describing', () => {
    const ALL = [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL];

    it('states a chip amount on every big_pots challenge', () => {
      for (const c of ALL.filter((x) => x.type === 'big_pots')) {
        expect(c.threshold, `"${c.id}" has no threshold`).toBeGreaterThan(0);
        // The number the server enforces must appear in the text the player
        // reads. This is the exact failure of "Win 4 big pots today".
        const withCommas = (c.threshold as number).toLocaleString('en-US');
        expect(
          c.description.includes(withCommas),
          `"${c.id}" says "${c.description}" but never states its ${withCommas} chip threshold`
        ).toBe(true);
      }
    });

    it('names the hand rank on every strong_hands challenge', () => {
      const NAMED = ['straight', 'flush', 'full house', 'four of a kind'];
      for (const c of ALL.filter((x) => x.type === 'strong_hands')) {
        expect(c.threshold, `"${c.id}" has no threshold`).toBeGreaterThan(0);
        const d = c.description.toLowerCase();
        expect(
          NAMED.some((n) => d.includes(n)),
          `"${c.id}" says "${c.description}" without naming which hand qualifies`
        ).toBe(true);
      }
    });

    it('states its own count or amount in every description', () => {
      for (const c of ALL) {
        const n = c.requirement.toLocaleString('en-US');
        // A requirement of 1 reads as an article in real English -- "Win A Pot
        // Worth 500 Chips Or More" is correct and "Win 1 Pot" is not how a
        // poker room writes it. Both spellings satisfy the rule that the
        // player can read the count off the card.
        const singular = c.requirement === 1 && /\b(a|an)\b/i.test(c.description);
        expect(
          c.description.includes(n) || c.description.includes(String(c.requirement)) || singular,
          `"${c.id}" says "${c.description}" but never states its requirement of ${n}`
        ).toBe(true);
      }
    });

    it('gives every challenge a threshold only where the type uses one', () => {
      for (const c of ALL) {
        if ((MAGNITUDE_TYPES as readonly string[]).includes(c.type)) {
          expect(c.threshold, `"${c.id}" is a magnitude type with no threshold`).toBeGreaterThan(0);
        } else {
          // A threshold on a pure counter would be silently ignored by the
          // server, so a card could promise a bar that is never applied.
          expect(c.threshold, `"${c.id}" carries a threshold its type ignores`).toBeUndefined();
        }
      }
    });

    it('pays diamonds on every challenge, and offers no chip reward at all', () => {
      // This test used to demand the OPPOSITE - `chipReward > 0` on every row,
      // with a message reading "pays no chips" - while the comment six screens
      // above it said rewards were strictly diamonds. Dan settled it on
      // 2026-09-05: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS."
      for (const c of ALL) {
        expect(c.diamondReward, `"${c.id}" pays nothing`).toBeGreaterThan(0);
        expect(c, `"${c.id}" still carries a chip reward`).not.toHaveProperty('chipReward');
      }
    });
  });

  describe('handRankScore', () => {
    // ORDER MATTERS: 'straight flush' contains both 'straight' and 'flush',
    // and 'royal flush' contains 'flush'. A naive substring ladder scores a
    // royal flush as a 6 and fails every quads-or-better challenge the player
    // legitimately earned.
    it('ranks the overlapping names correctly', () => {
      expect(handRankScore('Royal Flush')).toBe(10);
      expect(handRankScore('Straight Flush')).toBe(9);
      expect(handRankScore('Four of a Kind')).toBe(8);
      expect(handRankScore('Full House')).toBe(7);
      expect(handRankScore('Flush')).toBe(6);
      expect(handRankScore('Straight')).toBe(5);
    });

    it('accepts the shapes the engine actually emits', () => {
      // 'Full House', 'full_house' and 'FULL HOUSE' have all appeared.
      expect(handRankScore('full_house')).toBe(7);
      expect(handRankScore('FULL HOUSE')).toBe(7);
      expect(handRankScore('  Four Of A Kind  ')).toBe(8);
    });

    it('returns 0 for unknown or missing ranks', () => {
      expect(handRankScore(undefined)).toBe(0);
      expect(handRankScore('')).toBe(0);
      expect(handRankScore('banana')).toBe(0);
      // 0 must never clear a threshold, or a folded hand completes
      // "Win A Hand With Four Of A Kind Or Better".
      expect(handRankScore(undefined) >= 5).toBe(false);
    });

    it('keeps isStrongHand consistent with the scorer', () => {
      expect(isStrongHand('Royal Flush')).toBe(true);
      expect(isStrongHand('Straight')).toBe(true);
      expect(isStrongHand('Two Pair')).toBe(false);
      expect(isStrongHand(undefined)).toBe(false);
    });
  });

  describe('WEEKLY_CHALLENGE_POOL', () => {
    it('should contain at least 4 weekly challenges', () => {
      expect(WEEKLY_CHALLENGE_POOL.length).toBeGreaterThanOrEqual(4);
    });

    it('should have higher rewards than daily challenges', () => {
      // Measured in diamonds since 2026-09-05; the chip figures this compared
      // are gone. The ladder itself is unchanged.
      const maxDaily = Math.max(...CHALLENGE_POOL.map((c) => c.diamondReward));
      const minWeekly = Math.min(...WEEKLY_CHALLENGE_POOL.map((c) => c.diamondReward));
      expect(minWeekly).toBeGreaterThanOrEqual(maxDaily);
    });

    it('should have unique IDs', () => {
      const ids = WEEKLY_CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('MONTHLY_CHALLENGE_POOL', () => {
    it('should contain at least 3 monthly challenges', () => {
      expect(MONTHLY_CHALLENGE_POOL.length).toBeGreaterThanOrEqual(3);
    });

    it('should have the highest rewards', () => {
      const maxWeekly = Math.max(...WEEKLY_CHALLENGE_POOL.map((c) => c.diamondReward));
      const minMonthly = Math.min(...MONTHLY_CHALLENGE_POOL.map((c) => c.diamondReward));
      expect(minMonthly).toBeGreaterThanOrEqual(maxWeekly);
    });

    it('should have unique IDs', () => {
      const ids = MONTHLY_CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NO ID COLLISIONS ACROSS POOLS
  // ─────────────────────────────────────────────────────────────────────────

  describe('Cross-pool uniqueness', () => {
    it('should have no duplicate IDs across all challenge pools', () => {
      const allIds = [
        ...CHALLENGE_POOL.map((c) => c.id),
        ...WEEKLY_CHALLENGE_POOL.map((c) => c.id),
        ...MONTHLY_CHALLENGE_POOL.map((c) => c.id),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });
});

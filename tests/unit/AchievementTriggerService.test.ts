/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AchievementTriggerService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the auto-award trigger engine:
 * - onHandComplete: calls incrementProgress, checkWins, checkSpecialHand
 * - onTournamentComplete: increments tourney play/win
 * - onFriendAdded: increments friends_5 and friends_25
 * - onLogin: increments streak_7
 * - wireToHandController: event subscription and handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockIncrementProgress = vi.fn().mockResolvedValue({ unlocked: false, achievement: null });
const mockCheckWins = vi.fn().mockResolvedValue([]);
const mockCheckSpecialHand = vi.fn().mockResolvedValue(null);
const mockCheckHandsPlayed = vi.fn().mockResolvedValue([]);

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

vi.mock('../../src/services/AchievementService', () => ({
  achievementService: {
    incrementProgress: (...args: any[]) => mockIncrementProgress(...args),
    checkWins: (...args: any[]) => mockCheckWins(...args),
    checkSpecialHand: (...args: any[]) => mockCheckSpecialHand(...args),
    checkHandsPlayed: (...args: any[]) => mockCheckHandsPlayed(...args),
  },
  ACHIEVEMENTS: [],
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  pushNotificationService: {
    notifyAchievement: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { achievementTriggerService } from '../../src/services/AchievementTriggerService';

describe('AchievementTriggerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementProgress.mockResolvedValue({ unlocked: false, achievement: null });
    mockCheckWins.mockResolvedValue([]);
    mockCheckSpecialHand.mockResolvedValue(null);
    mockCheckHandsPlayed.mockResolvedValue([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ON HAND COMPLETE
  // ─────────────────────────────────────────────────────────────────────────

  describe('onHandComplete', () => {
    it('should always increment hands_100 progress', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: false,
        potSize: 100,
        showdown: true,
      });

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'hands_100');
    });

    it('should return triggered achievements when unlocked', async () => {
      mockIncrementProgress.mockResolvedValue({
        unlocked: true,
        achievement: { id: 'hands_100', name: 'Card Shark', chipReward: 500 },
      });

      const result = await achievementTriggerService.onHandComplete('user-1', {
        won: false,
        potSize: 100,
        showdown: true,
      });

      expect(result.triggeredAchievements.length).toBeGreaterThanOrEqual(1);
      expect(result.triggeredAchievements[0].name).toBe('Card Shark');
    });

    it('should check wins when hand was won', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 200,
        showdown: true,
      });

      expect(mockCheckWins).toHaveBeenCalled();
    });

    it('should NOT check wins when hand was lost', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: false,
        potSize: 200,
        showdown: true,
      });

      expect(mockCheckWins).not.toHaveBeenCalled();
    });

    it('should check special hand rank when provided', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 500,
        handRank: 'Royal Flush',
        showdown: true,
      });

      expect(mockCheckSpecialHand).toHaveBeenCalledWith('user-1', 'Royal Flush');
    });

    it('should NOT check special hand rank when not provided', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 500,
        showdown: true,
      });

      expect(mockCheckSpecialHand).not.toHaveBeenCalled();
    });

    it('should accumulate chips from multiple achievements', async () => {
      mockCheckWins.mockResolvedValue([
        { name: 'Win Streak', chipReward: 100 },
        { name: 'Win Master', chipReward: 250 },
      ]);

      const result = await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 500,
        showdown: true,
      });

      expect(result.chipsAwarded).toBeGreaterThanOrEqual(350);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ON TOURNAMENT COMPLETE
  // ─────────────────────────────────────────────────────────────────────────

  describe('onTournamentComplete', () => {
    it('should increment tourney_played_10', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 5,
        entries: 50,
        won: false,
        prizeAmount: 0,
      });

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'tourney_played_10');
    });

    it('should increment tourney_wins_5 only when won', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 1,
        entries: 50,
        won: true,
        prizeAmount: 5000,
      });

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'tourney_wins_5');
    });

    it('should NOT increment tourney_wins_5 when not won', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 10,
        entries: 50,
        won: false,
        prizeAmount: 0,
      });

      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'tourney_wins_5');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ON FRIEND ADDED
  // ─────────────────────────────────────────────────────────────────────────

  describe('onFriendAdded', () => {
    it('should increment both friends_5 and friends_25', async () => {
      await achievementTriggerService.onFriendAdded('user-1');

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'friends_5');
      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'friends_25');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ON LOGIN
  // ─────────────────────────────────────────────────────────────────────────

  describe('onLogin', () => {
    it('should increment streak_7', async () => {
      await achievementTriggerService.onLogin('user-1');

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'streak_7');
    });
  });
});

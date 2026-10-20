/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AchievementTriggerService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the auto-award trigger engine:
 * - onHandComplete: calls incrementProgress, checkWins (special hands are the server's)
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
const mockRecordLogin = vi.fn().mockResolvedValue({ counted: false, streak: 0, unlocked: [] });

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
      // The owner door (ruling 25) is a builder like a table read; every other
      // rpc resolves as before.
      rpc: vi.fn((name: string) =>
        name === 'get_my_full_profile' ? buildChain() : Promise.resolve({ data: null, error: null })
      ),
    },
  };
});

vi.mock('../../src/services/AchievementService', () => ({
  achievementService: {
    incrementProgress: (...args: any[]) => mockIncrementProgress(...args),
    checkWins: (...args: any[]) => mockCheckWins(...args),
    checkSpecialHand: (...args: any[]) => mockCheckSpecialHand(...args),
    checkHandsPlayed: (...args: any[]) => mockCheckHandsPlayed(...args),
    recordLogin: (...args: any[]) => mockRecordLogin(...args),
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
    mockRecordLogin.mockResolvedValue({ counted: false, streak: 0, unlocked: [] });
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
        achievement: { id: 'hands_100', name: 'Card Shark', diamondReward: 500 },
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

    // REPLACED 2026-10-20. The browser reported Royal Flush / Straight Flush
    // / Four Of A Kind from the winning hand's display name, which the mapping
    // never recognised, and a horse has no browser. The database records all
    // three from the engine's per-player hand record now
    // (trg_hand_history_royal_flush_achievement / _straight_flush_quads_achievements), so nothing is sent here.
    it('never reports a special hand from the browser', async () => {
      await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 500,
        showdown: true,
      });

      expect(mockCheckSpecialHand).not.toHaveBeenCalled();
      for (const call of mockIncrementProgress.mock.calls) {
        expect(['royal_flush', 'straight_flush', 'quads']).not.toContain(call[1]);
      }
    });

    // REPLACED 2026-10-19. This summed `chipReward` off whatever the browser
    // had just unlocked. Nothing a browser reports pays anything now: rewards
    // are diamonds the SERVER credits on an unlock it proves itself, so a
    // browser-reported unlock counts no diamonds whatever its catalog says.
    it('credits no diamonds for a browser-reported unlock', async () => {
      mockCheckWins.mockResolvedValue([
        { id: 'wins_10', name: 'Win Streak', diamondReward: 100 },
        { id: 'wins_100', name: 'Win Master', diamondReward: 250 },
      ]);

      const result = await achievementTriggerService.onHandComplete('user-1', {
        won: true,
        potSize: 500,
        showdown: true,
      });

      expect(result.triggeredAchievements).toHaveLength(2);
      expect(result.diamondsAwarded).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ON TOURNAMENT COMPLETE
  // ─────────────────────────────────────────────────────────────────────────

  // UPDATED: the tournament achievement IDs were corrected in
  // src/services/AchievementTriggerService.ts — 'tourney_played_10' and
  // 'tourney_wins_5' never existed in the ACHIEVEMENTS catalogue, so those
  // increments silently no-op'd. The real IDs (see src/services/
  // AchievementService.ts) are 'tourney_played_50' and 'tourney_win_1'.
  describe('onTournamentComplete', () => {
    it('should increment tourney_played_50', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 5,
        entries: 50,
        won: false,
        prizeAmount: 0,
      });

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'tourney_played_50');
    });

    it('should increment tourney_win_1 only when won', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 1,
        entries: 50,
        won: true,
        prizeAmount: 5000,
      });

      expect(mockIncrementProgress).toHaveBeenCalledWith('user-1', 'tourney_win_1');
    });

    it('should NOT increment tourney_win_1 when not won', async () => {
      await achievementTriggerService.onTournamentComplete('user-1', {
        position: 10,
        entries: 50,
        won: false,
        prizeAmount: 0,
      });

      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'tourney_win_1');
      // ...and the stale IDs must never come back: they match nothing in the
      // ACHIEVEMENTS catalogue, so awarding through them is a silent no-op.
      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'tourney_played_10');
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
    // REPLACED 2026-08-29, in the commit that removed the behaviour it pinned.
    //
    // This asserted that onLogin calls `incrementProgress('user-1',
    // 'streak_7')`. That was the FARM: onLogin runs on every Supabase auth
    // event (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED), so reloading the
    // page advanced "Log in 7 days in a row" and, at 30 and 100, paid 100 and
    // 500 chips through `add_to_promo_wallet`. Production carried the proof:
    // 3 of 5 streak_7 unlocks and 1 of 2 streak_30 unlocks were stamped
    // `unlocked_at` on the same day the row was created.
    //
    // The streak is now computed once per UTC day from profiles.last_login_date
    // and written with `incrementProgressTo`, so `incrementProgress` is no
    // longer the right thing to look for. The rule that replaces it — a second
    // visit on the same day writes nothing at all — is pinned in full in
    // `achievementsCannotBeFarmed.test.ts`, which mocks the profile row and can
    // therefore drive every branch. Here we assert only what this file's
    // shared mock can honestly see: onLogin no longer bumps a streak by one.
    it('never bumps a streak by one, because a streak counts days not loads', async () => {
      await achievementTriggerService.onLogin('user-1');

      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'streak_7');
      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'streak_30');
      expect(mockIncrementProgress).not.toHaveBeenCalledWith('user-1', 'streak_100');
    });

    it('asks the server to count the day, and credits what the server reports paying', async () => {
      mockRecordLogin.mockResolvedValue({
        counted: true,
        streak: 30,
        unlocked: [
          { achievement: { id: 'streak_30', name: 'Monthly Grinder' }, diamondsAwarded: 100 },
        ],
      });
      const result = await achievementTriggerService.onLogin('user-1');
      expect(mockRecordLogin).toHaveBeenCalledTimes(1);
      expect(result.diamondsAwarded).toBe(100);
      expect(result.triggeredAchievements.map((a) => a.id)).toEqual(['streak_30']);
    });
  });
});

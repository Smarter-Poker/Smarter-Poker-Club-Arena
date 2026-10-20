/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AchievementService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the ACHIEVEMENTS catalog and pure lookup methods:
 * - ACHIEVEMENTS: static catalog integrity
 * - getAll: filters hidden achievements
 * - getByCategory: correct category filtering
 * - getById: exact lookups
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { achievementService, ACHIEVEMENTS } from '../../src/services/AchievementService';

describe('AchievementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STATIC CATALOG INTEGRITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('ACHIEVEMENTS catalog', () => {
    it('should contain at least 20 achievements', () => {
      expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(20);
    });

    it('should have unique IDs', () => {
      const ids = ACHIEVEMENTS.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid categories', () => {
      const validCats = ['hands', 'wins', 'social', 'financial', 'special', 'tournament'];
      for (const a of ACHIEVEMENTS) {
        expect(validCats).toContain(a.category);
      }
    });

    it('should have valid rarities', () => {
      const validRarities = ['common', 'rare', 'epic', 'legendary'];
      for (const a of ACHIEVEMENTS) {
        expect(validRarities).toContain(a.rarity);
      }
    });

    it('should have positive requirements', () => {
      for (const a of ACHIEVEMENTS) {
        expect(a.requirement).toBeGreaterThan(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getAll
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('should exclude hidden achievements', () => {
      const all = achievementService.getAll();
      // bad_beat is hidden
      expect(all.find((a) => a.id === 'bad_beat')).toBeUndefined();
    });

    it('should return fewer items than full catalog when hidden exist', () => {
      const hidden = ACHIEVEMENTS.filter((a) => a.hidden);
      if (hidden.length > 0) {
        expect(achievementService.getAll().length).toBeLessThan(ACHIEVEMENTS.length);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getByCategory
  // ─────────────────────────────────────────────────────────────────────────

  describe('getByCategory', () => {
    it('should return only hands category', () => {
      const hands = achievementService.getByCategory('hands');
      expect(hands.length).toBeGreaterThanOrEqual(4); // hands_100, hands_1000, hands_10000, hands_100000
      for (const a of hands) {
        expect(a.category).toBe('hands');
      }
    });

    it('should return only wins category', () => {
      const wins = achievementService.getByCategory('wins');
      expect(wins.length).toBeGreaterThanOrEqual(3);
      for (const a of wins) {
        expect(a.category).toBe('wins');
      }
    });

    it('should exclude hidden items from category results', () => {
      const special = achievementService.getByCategory('special');
      // bad_beat is special but hidden
      expect(special.find((a) => a.id === 'bad_beat')).toBeUndefined();
    });

    it('should return empty array for nonexistent category', () => {
      const result = achievementService.getByCategory('nonexistent' as any);
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getById
  // ─────────────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('should return correct achievement', () => {
      const a = achievementService.getById('hands_100');
      expect(a).toBeDefined();
      expect(a!.name).toBe('Getting Started');
      expect(a!.requirement).toBe(100);
    });

    it('should return hidden achievements too (getById bypasses hidden filter)', () => {
      const a = achievementService.getById('bad_beat');
      expect(a).toBeDefined();
      expect(a!.name).toBe('Bad Beat Survivor');
    });

    it('should return undefined for nonexistent ID', () => {
      expect(achievementService.getById('nonexistent')).toBeUndefined();
    });

    it('should find royal_flush paying 500 diamonds, proved by the server', () => {
      const a = achievementService.getById('royal_flush');
      expect(a).toBeDefined();
      expect(a!.diamondReward).toBe(500);
      expect(a!.serverProved).toBe(true);
      expect(a!.rarity).toBe('legendary');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DIAMOND REWARDS (2026-10-19)
  // ─────────────────────────────────────────────────────────────────────────

  describe('diamond rewards', () => {
    it('pays exactly royal_flush 500, streak_30 100 and streak_100 500, and nothing in chips', () => {
      const paying = ACHIEVEMENTS.filter((a) => (a.diamondReward ?? 0) > 0)
        .map((a) => `${a.id}=${a.diamondReward}`)
        .sort();
      expect(paying).toEqual(['royal_flush=500', 'streak_100=500', 'streak_30=100']);
      for (const a of ACHIEVEMENTS) expect(a).not.toHaveProperty('chipReward');
    });

    it('only a server-proved achievement carries a reward', () => {
      for (const a of ACHIEVEMENTS) {
        if ((a.diamondReward ?? 0) > 0) expect(a.serverProved, a.id).toBe(true);
      }
    });

    it('never sends a server-proved achievement from the browser', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      for (const id of [
        'royal_flush',
        'straight_flush',
        'quads',
        'streak_7',
        'streak_30',
        'streak_100',
      ]) {
        await expect(achievementService.incrementProgress('u1', id, 1)).resolves.toEqual({
          unlocked: false,
        });
        await expect(achievementService.incrementProgressTo('u1', id, 999)).resolves.toEqual({
          unlocked: false,
        });
        await achievementService.setProgress('u1', id, 999);
      }
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('reads the login result the server reports, crediting only what it says it paid', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: {
          ok: true,
          counted: true,
          streak: 30,
          unlocked: [
            { achievement_id: 'streak_7', diamonds_awarded: 0 },
            { achievement_id: 'streak_30', diamonds_awarded: 100 },
            { achievement_id: 'not_an_achievement', diamonds_awarded: 9999 },
          ],
        },
        error: null,
      } as never);
      const login = await achievementService.recordLogin();
      expect(supabase.rpc).toHaveBeenCalledWith('fn_achievement_record_login');
      expect(login.counted).toBe(true);
      expect(login.streak).toBe(30);
      expect(login.unlocked.map((u) => `${u.achievement.id}=${u.diamondsAwarded}`)).toEqual([
        'streak_7=0',
        'streak_30=100',
      ]);
    });

    it('a refused login count throws rather than reading as zero', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: null,
        error: { message: 'permission denied' },
      } as never);
      await expect(achievementService.recordLogin()).rejects.toBeTruthy();
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ProfileService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - VIP_THRESHOLDS constant integrity
 * - getProfile: returns null for missing user
 * - getProfileByUsername: returns null for missing user
 * - getPublicProfile: returns null for missing user
 * - updateProfile: emits PROFILE_UPDATED on success
 * - getStats: returns defaults for empty data
 * - hasTOSAccepted: returns false for missing data
 * - acceptTOS: emits PROFILE_UPDATED
 * - getLeaderboard: returns empty array for no data
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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { profileService } from '../../src/services/ProfileService';
import { masterBus } from '../../src/core/MasterBus';

describe('ProfileService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY METHODS — null/empty returns
  // ─────────────────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getProfile('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getProfileByUsername', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getProfileByUsername('nobody');
      expect(result).toBeNull();
    });
  });

  describe('getPublicProfile', () => {
    it('should return null when no data', async () => {
      const result = await profileService.getPublicProfile('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UPDATE — bus emission
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('should emit PROFILE_UPDATED on success (error=null)', async () => {
      const result = await profileService.updateProfile('user-1', { bio: 'test' });
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('PROFILE_UPDATED', {
        userId: 'user-1',
        updates: { bio: 'test' },
      });
    });
  });

  describe('acceptTOS', () => {
    it('should emit PROFILE_UPDATED on success (error=null)', async () => {
      const result = await profileService.acceptTOS('user-1');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('PROFILE_UPDATED', {
        userId: 'user-1',
        updates: { tosAccepted: true },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getStats — defaults for empty data
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return default stats when no data', async () => {
      const stats = await profileService.getStats('user-1');
      expect(stats).toEqual({
        totalHands: 0,
        winRate: 0,
        avgProfit: 0,
        biggestWin: 0,
        favoriteVariant: "No Limit Hold'em",
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // hasTOSAccepted / getLeaderboard
  // ─────────────────────────────────────────────────────────────────────────

  describe('hasTOSAccepted', () => {
    it('should return false when no data', async () => {
      const result = await profileService.hasTOSAccepted('user-1');
      expect(result).toBe(false);
    });
  });

  describe('getLeaderboard', () => {
    it('should return empty array when no data', async () => {
      const result = await profileService.getLeaderboard('winnings');
      expect(result).toEqual([]);
    });
  });
});

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

// 2026-08-15: single-row reads are now overridable per test so hasTOSAccepted
// can be exercised on a profile row that actually exists (see below). Defaults
// to the previous behaviour, `{ data: null, error: null }`.
const rowState = vi.hoisted(() => ({
  single: { data: null as any, error: null as any },
}));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve(rowState.single);
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
    rowState.single = { data: null, error: null };
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
    // 2026-08-15: the old expectation (no data => false) contradicted the
    // service. hasTOSAccepted FAILS OPEN by design (ProfileService.ts:333,338:
    // "Default to accepted if query fails" / "to avoid blocking") — a missing
    // row or a failed query must not lock a user out of Club Arena. The real
    // false case is a profile that exists without the preferences flag, which
    // the old mock could never produce; it is now covered explicitly below.
    it('should fail open (true) when the profile row is missing', async () => {
      const result = await profileService.hasTOSAccepted('user-1');
      expect(result).toBe(true);
    });

    it('should fail open (true) when the query errors', async () => {
      rowState.single = { data: null, error: { message: 'boom' } };
      const result = await profileService.hasTOSAccepted('user-1');
      expect(result).toBe(true);
    });

    it('should return false when the profile has no TOS flag in preferences', async () => {
      rowState.single = { data: { preferences: { theme: 'dark' } }, error: null };
      const result = await profileService.hasTOSAccepted('user-1');
      expect(result).toBe(false);
    });

    it('should return true when preferences carry club_arena_tos_accepted', async () => {
      rowState.single = {
        data: { preferences: { club_arena_tos_accepted: true } },
        error: null,
      };
      const result = await profileService.hasTOSAccepted('user-1');
      expect(result).toBe(true);
    });
  });

  describe('getLeaderboard', () => {
    it('should return empty array when no data', async () => {
      const result = await profileService.getLeaderboard('winnings');
      expect(result).toEqual([]);
    });
  });
});

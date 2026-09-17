/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests slug generation, search, getClub UUID routing, and club limit checks.
 * NOTE: ClubsService uses @/ path aliases which resolve to src/ via tsconfig.
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
          return (resolve: (v: any) => void) => resolve({ data: null, error: null, count: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'test-user-id' } } }),
      },
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'test/path.png' }, error: null }),
          getPublicUrl: vi
            .fn()
            .mockReturnValue({ data: { publicUrl: 'https://cdn.test/path.png' } }),
        }),
      },
    },
    // 2026-08-15: src/lib/supabase also exports the getAuthUser() helper, and
    // ClubsService imports it (ClubsService.ts:8) for canJoinMoreClubs. This
    // suite-local mock only stubbed the `supabase` client, so vitest threw
    // 'No "getAuthUser" export is defined on the "../../src/lib/supabase" mock'.
    // Mirrors the real helper's shape: { data: { user }, error }.
    getAuthUser: vi.fn().mockResolvedValue({
      data: { user: { id: 'test-user-id' } },
      error: null,
    }),
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { supabase } from '../../src/lib/supabase';
import { ClubsService, searchClubs, getClub, retireClub } from '../../src/services/ClubsService';

describe('ClubsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────────────────────────────────────────

  describe('searchClubs', () => {
    it('should return empty array when no matches', async () => {
      const result = await searchClubs('nonexistent');
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET CLUB
  // ─────────────────────────────────────────────────────────────────────────

  describe('getClub', () => {
    it('should return null when club not found', async () => {
      const result = await getClub('nonexistent-slug');
      expect(result).toBeNull();
    });

    it('should detect UUID format vs slug', async () => {
      // UUID should query by 'id' column
      const result = await getClub('12345678-1234-1234-1234-123456789012');
      expect(result).toBeNull(); // Still null from mock, but tests the branching
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLUB LIMIT
  // ─────────────────────────────────────────────────────────────────────────

  describe('canJoinMoreClubs', () => {
    it('should return canJoin=true with maxClubs=4 when count is 0', async () => {
      const result = await ClubsService.canJoinMoreClubs();
      expect(result.maxClubs).toBe(4);
      expect(result.canJoin).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });

  describe('retireClub', () => {
    it('forwards the human-typed club name instead of refetching a confirmation value', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: { success: true, already_retired: false },
        error: null,
      } as any);

      await retireClub('25450', 'Human Typed Name', 'Owner chose to close');

      expect(supabase.rpc).toHaveBeenCalledWith('fn_retire_settled_club', {
        p_club_id: 'resolved-uuid',
        p_confirm_name: 'Human Typed Name',
        p_reason: 'Owner chose to close',
      });
    });

    it('fails closed before the RPC when no confirmation was typed', async () => {
      await expect(retireClub('25450', '   ')).rejects.toThrow(/type the club name/i);
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SERVICE OBJECT SHAPE
  // ─────────────────────────────────────────────────────────────────────────

  describe('ClubsService export', () => {
    it('should expose all expected methods', () => {
      expect(typeof ClubsService.search).toBe('function');
      expect(typeof ClubsService.get).toBe('function');
      expect(typeof ClubsService.create).toBe('function');
      expect(typeof ClubsService.update).toBe('function');
      expect(typeof ClubsService.join).toBe('function');
      expect(typeof ClubsService.leave).toBe('function');
      expect(typeof ClubsService.retire).toBe('function');
      expect(typeof ClubsService.delete).toBe('function');
      expect(typeof ClubsService.getUserMemberships).toBe('function');
      expect(typeof ClubsService.getMembers).toBe('function');
      expect(typeof ClubsService.getChallenges).toBe('function');
      expect(typeof ClubsService.getLeaderboard).toBe('function');
      expect(typeof ClubsService.uploadLogo).toBe('function');
      expect(typeof ClubsService.uploadBanner).toBe('function');
      expect(typeof ClubsService.canJoinMoreClubs).toBe('function');
    });
  });
});

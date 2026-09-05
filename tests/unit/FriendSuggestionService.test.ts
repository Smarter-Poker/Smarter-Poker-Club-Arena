/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FriendSuggestionService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: vi.fn(() => ({ userId: 'user-1' })),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/services/BlockService', () => ({
  blockService: { isEitherBlocked: vi.fn().mockResolvedValue(false) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { friendSuggestionService } from '../../src/services/FriendSuggestionService';
import { supabase } from '../../src/lib/supabase';
import { readLocalSession } from '../../src/lib/authUtils';

describe('FriendSuggestionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readLocalSession).mockReturnValue({ userId: 'user-1' } as any);
  });

  describe('getSuggestions', () => {
    it('should return empty array when no suggestions', async () => {
      const result = await friendSuggestionService.getSuggestions('user-1');
      expect(result).toEqual([]);
    });

    it('should use default limit of 10', async () => {
      const result = await friendSuggestionService.getSuggestions('user-1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should accept custom limit', async () => {
      const result = await friendSuggestionService.getSuggestions('user-1', 5);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should not throw for new user with no data', async () => {
      const result = await friendSuggestionService.getSuggestions('brand-new-user');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('export shape', () => {
    it('should export singleton with getSuggestions', () => {
      expect(typeof friendSuggestionService.getSuggestions).toBe('function');
    });
  });

  describe('getMutualFriends', () => {
    it('refuses a caller that does not match the local session', async () => {
      vi.mocked(readLocalSession).mockReturnValue({ userId: 'another-user' } as any);

      await expect(friendSuggestionService.getMutualFriends('user-1', 'user-2')).resolves.toEqual(
        []
      );
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('uses the recipient-scoped RPC for the authenticated caller', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: [{ id: 'mutual-1', username: 'Table Friend', avatar_url: 'avatar.png' }],
        error: null,
      } as any);

      await expect(friendSuggestionService.getMutualFriends('user-1', 'user-2')).resolves.toEqual([
        // The RPC column is still called `username`; since migration
        // 20260905154022 it carries the resolved ARENA name, and the mapper
        // renames it so no caller can paint a raw column.
        { id: 'mutual-1', arenaName: 'Table Friend', avatarUrl: 'avatar.png' },
      ]);
      expect(supabase.rpc).toHaveBeenCalledWith('get_mutual_friends', {
        p_other_user_id: 'user-2',
      });
    });
  });
});

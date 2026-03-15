/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FriendSuggestionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - getSuggestions: returns empty array on error/no data
 * - getMutualFriends: returns empty array on no data
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

vi.mock('../../src/services/BlockService', () => ({
  blockService: {
    isEitherBlocked: vi.fn().mockResolvedValue(false),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { friendSuggestionService } from '../../src/services/FriendSuggestionService';

describe('FriendSuggestionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSuggestions', () => {
    it('should return empty array when no data is available', async () => {
      const suggestions = await friendSuggestionService.getSuggestions('user-1');
      expect(suggestions).toEqual([]);
    });

    it('should respect the limit parameter', async () => {
      const suggestions = await friendSuggestionService.getSuggestions('user-1', 5);
      expect(suggestions.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getMutualFriends', () => {
    it('should return empty array when no mutual friends', async () => {
      const mutuals = await friendSuggestionService.getMutualFriends('user-1', 'user-2');
      expect(mutuals).toEqual([]);
    });
  });
});

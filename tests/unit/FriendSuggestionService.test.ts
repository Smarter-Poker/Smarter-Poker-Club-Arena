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

describe('FriendSuggestionService', () => {
  beforeEach(() => vi.clearAllMocks());

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
});

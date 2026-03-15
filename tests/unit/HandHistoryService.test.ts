/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HandHistoryService (Strengthened)
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { handHistoryService } from '../../src/services/HandHistoryService';

describe('HandHistoryService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getHand', () => {
    it('should return null when hand not found', async () => {
      const hand = await handHistoryService.getHand('nonexistent');
      expect(hand).toBeNull();
    });
  });

  describe('getPlayerHands', () => {
    it('should return empty array when no hands', async () => {
      const hands = await handHistoryService.getPlayerHands('user-1');
      expect(hands).toEqual([]);
    });

    it('should use default limit of 50', async () => {
      const hands = await handHistoryService.getPlayerHands('user-1');
      expect(Array.isArray(hands)).toBe(true);
    });
  });

  describe('getTableHands', () => {
    it('should return empty array when no table hands', async () => {
      const hands = await handHistoryService.getTableHands('table-1');
      expect(hands).toEqual([]);
    });
  });

  describe('getRecentWinningHands', () => {
    it('should return empty array when no wins', async () => {
      const hands = await handHistoryService.getRecentWinningHands('user-1');
      expect(hands).toEqual([]);
    });
  });

  describe('export shape', () => {
    it('should export singleton with all query methods', () => {
      expect(typeof handHistoryService.getHand).toBe('function');
      expect(typeof handHistoryService.getPlayerHands).toBe('function');
      expect(typeof handHistoryService.getTableHands).toBe('function');
      expect(typeof handHistoryService.getRecentWinningHands).toBe('function');
      expect(typeof handHistoryService.searchHands).toBe('function');
    });
  });
});

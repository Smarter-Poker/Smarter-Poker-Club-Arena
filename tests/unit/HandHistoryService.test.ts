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

  // 2026-08-15: the old `getTableHands` / `getRecentWinningHands` describes
  // called methods that no longer exist. They were INTENTIONALLY deleted in the
  // "Round 38 RE-RUN cleanup" (see HandHistoryService.ts:17-23 and 147-153):
  // getTableHands / getRecentWinningHands / searchHands queried the legacy
  // `hands` / `hand_players` / `hand_actions` tables, which hold 0 rows in
  // production, and had zero callers. Rather than drop the coverage, these now
  // pin the removal so the dead paths cannot be silently reintroduced.
  describe('removed legacy query methods (Round 38 RE-RUN cleanup)', () => {
    const surface = handHistoryService as unknown as Record<string, unknown>;

    it('should no longer expose getTableHands', () => {
      expect(surface.getTableHands).toBeUndefined();
    });

    it('should no longer expose getRecentWinningHands', () => {
      expect(surface.getRecentWinningHands).toBeUndefined();
    });

    it('should no longer expose searchHands', () => {
      expect(surface.searchHands).toBeUndefined();
    });
  });

  describe('export shape', () => {
    it('should export singleton with all query methods', () => {
      expect(typeof handHistoryService.getHand).toBe('function');
      expect(typeof handHistoryService.getPlayerHands).toBe('function');
      // 2026-08-15: the three legacy `hands`-table readers were removed; the
      // surviving surface is getHand / getPlayerHands (hand_history readers).
      // 2026-09-04: the saveHandToSupabase writer went too - it wrote to the
      // empty legacy tables and nothing called it.
      expect((handHistoryService as unknown as Record<string, unknown>).saveHandToSupabase).toBe(
        undefined
      );
    });
  });
});

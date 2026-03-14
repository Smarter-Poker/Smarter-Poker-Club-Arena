/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HandHistoryService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests hand history query methods with mocked Supabase:
 * - getHand: returns null for missing hand
 * - getPlayerHands: returns empty array when no data
 * - getTableHands: returns empty array when no data
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
    },
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { handHistoryService } from '../../src/services/HandHistoryService';

describe('HandHistoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getHand', () => {
    it('should return null when no data', async () => {
      const result = await handHistoryService.getHand('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('getPlayerHands', () => {
    it('should return empty array when no data', async () => {
      const result = await handHistoryService.getPlayerHands('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getTableHands', () => {
    it('should return empty array when no data', async () => {
      const result = await handHistoryService.getTableHands('table-1');
      expect(result).toEqual([]);
    });
  });
});

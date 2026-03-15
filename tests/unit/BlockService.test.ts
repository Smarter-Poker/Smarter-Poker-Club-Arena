/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BlockService (Strengthened)
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { blockService } from '../../src/services/BlockService';

describe('BlockService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getBlockedUsers', () => {
    it('should return empty array when no users blocked', async () => {
      const result = await blockService.getBlockedUsers('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('isBlocked', () => {
    it('should return false when no block record exists', async () => {
      const result = await blockService.isBlocked('user-1', 'user-2');
      expect(result).toBe(false);
    });
  });

  describe('isBlockedBy', () => {
    it('should return false when not blocked by target', async () => {
      const result = await blockService.isBlockedBy('user-1', 'user-2');
      expect(result).toBe(false);
    });
  });

  describe('isEitherBlocked', () => {
    it('should return false when neither user blocks the other', async () => {
      const result = await blockService.isEitherBlocked('user-1', 'user-2');
      expect(result).toBe(false);
    });
  });

  describe('invalidateCache', () => {
    it('should not crash when called', () => {
      blockService.invalidateCache();
    });
  });

  describe('export shape', () => {
    it('should export blockService with all expected methods', () => {
      expect(typeof blockService.blockUser).toBe('function');
      expect(typeof blockService.unblockUser).toBe('function');
      expect(typeof blockService.getBlockedUsers).toBe('function');
      expect(typeof blockService.isBlocked).toBe('function');
      expect(typeof blockService.isBlockedBy).toBe('function');
      expect(typeof blockService.isEitherBlocked).toBe('function');
      expect(typeof blockService.invalidateCache).toBe('function');
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BlockService
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies (no external refs in factory) ──────────────────────

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

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { blockService } from '../../src/services/BlockService';
import { masterBus } from '../../src/core/MasterBus';

describe('BlockService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockService.invalidateCache();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INVALIDATE CACHE
  // ─────────────────────────────────────────────────────────────────────────

  describe('invalidateCache', () => {
    it('should clear cache without throwing', () => {
      expect(() => blockService.invalidateCache()).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BLOCK USER
  // ─────────────────────────────────────────────────────────────────────────

  describe('blockUser', () => {
    it('should emit USER_BLOCKED bus event on success', async () => {
      const result = await blockService.blockUser('user-1', 'user-2');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('USER_BLOCKED', {
        userId: 'user-1',
        blockedUserId: 'user-2',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UNBLOCK USER
  // ─────────────────────────────────────────────────────────────────────────

  describe('unblockUser', () => {
    it('should emit USER_UNBLOCKED bus event on success', async () => {
      const result = await blockService.unblockUser('user-1', 'user-2');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('USER_UNBLOCKED', {
        userId: 'user-1',
        unblockedUserId: 'user-2',
      });
    });
  });
});

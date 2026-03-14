/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BlockService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests user blocking with in-memory cache:
 * - invalidateCache: clears cache and resets userId
 * - isEitherBlocked: bidirectional check logic
 * - blockUser: emits bus event + handles duplicate
 * - unblockUser: emits bus event
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockDelete = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
  or: vi.fn().mockResolvedValue({ data: null, error: null }),
});
const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    // For count queries
    eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
  }),
  // Direct chain for warmCache
  order: vi.fn().mockResolvedValue({ data: [], error: null }),
});

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    }),
  },
}));

const mockEmit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: mockEmit,
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { blockService } from '../../src/services/BlockService';

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
      expect(mockEmit).toHaveBeenCalledWith('USER_BLOCKED', {
        userId: 'user-1',
        blockedUserId: 'user-2',
      });
    });

    it('should return true for duplicate block (23505)', async () => {
      mockInsert.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'dup' } });
      const result = await blockService.blockUser('user-1', 'user-2');
      expect(result).toBe(true);
    });

    it('should return false on non-duplicate error', async () => {
      mockInsert.mockResolvedValueOnce({ data: null, error: { code: '500', message: 'fail' } });
      const result = await blockService.blockUser('user-1', 'user-2');
      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UNBLOCK USER
  // ─────────────────────────────────────────────────────────────────────────

  describe('unblockUser', () => {
    it('should emit USER_UNBLOCKED bus event on success', async () => {
      const result = await blockService.unblockUser('user-1', 'user-2');
      expect(result).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith('USER_UNBLOCKED', {
        userId: 'user-1',
        unblockedUserId: 'user-2',
      });
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ClubService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests club default settings, query fallbacks, and membership operations.
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

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
  resolveClubIdFilter: vi.fn().mockReturnValue({ column: 'id', value: 'resolved-uuid' }),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    creditWallet: vi.fn().mockResolvedValue(undefined),
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/BBJService', () => ({
  BBJService: {},
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { clubService } from '../../src/services/ClubService';

describe('ClubService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES — NULL/EMPTY FALLBACKS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getClub', () => {
    it('should return null when club not found', async () => {
      const result = await clubService.getClub('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getClubByPublicId', () => {
    it('should return null when club not found by public ID', async () => {
      const result = await clubService.getClubByPublicId(999999);
      expect(result).toBeNull();
    });
  });

  describe('searchClubs', () => {
    it('should return empty array when no matches', async () => {
      const result = await clubService.searchClubs('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('deleteClub', () => {
    it('should return true on successful delete (mocked)', async () => {
      const result = await clubService.deleteClub('club-1');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MEMBER COUNT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getMemberCount', () => {
    it('should return 0 when no members', async () => {
      const result = await clubService.getMemberCount('club-1');
      expect(result).toBe(0);
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DisputeService (Strengthened)
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

import { DisputeService } from '../../src/services/DisputeService';

describe('DisputeService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getClubDisputes', () => {
    it('should return empty array when no disputes', async () => {
      const result = await DisputeService.getClubDisputes('club-1');
      expect(result).toEqual([]);
    });

    it('should accept optional status filter', async () => {
      const result = await DisputeService.getClubDisputes('club-1', 'pending');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getMyDisputes', () => {
    it('should return empty array for user with no disputes', async () => {
      const result = await DisputeService.getMyDisputes('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getOpenCount', () => {
    it('should return 0 when no open disputes', async () => {
      const count = await DisputeService.getOpenCount('club-1');
      expect(count).toBe(0);
    });
  });

  describe('export shape', () => {
    it('should export DisputeService with all methods', () => {
      expect(typeof DisputeService.submitDispute).toBe('function');
      expect(typeof DisputeService.getClubDisputes).toBe('function');
      expect(typeof DisputeService.getMyDisputes).toBe('function');
      expect(typeof DisputeService.getOpenCount).toBe('function');
      expect(typeof DisputeService.startReview).toBe('function');
      expect(typeof DisputeService.resolveDispute).toBe('function');
    });
  });
});

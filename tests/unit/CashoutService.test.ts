/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CashoutService (Strengthened)
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

import { cashoutService } from '../../src/services/CashoutService';

describe('CashoutService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getCashout', () => {
    it('should return null for unknown cashout', async () => {
      const result = await cashoutService.getCashout('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAgentPendingCashouts', () => {
    it('should return empty array when no pending cashouts', async () => {
      const result = await cashoutService.getAgentPendingCashouts('agent-1');
      expect(result).toEqual([]);
    });

    it('should accept optional clubId filter', async () => {
      const result = await cashoutService.getAgentPendingCashouts('agent-1', 'club-1');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('export shape', () => {
    it('should export cashoutService with all methods', () => {
      expect(typeof cashoutService.requestCashout).toBe('function');
      expect(typeof cashoutService.cancelCashout).toBe('function');
      expect(typeof cashoutService.approveCashout).toBe('function');
      expect(typeof cashoutService.completeCashout).toBe('function');
      expect(typeof cashoutService.rejectCashout).toBe('function');
      expect(typeof cashoutService.getCashout).toBe('function');
      expect(typeof cashoutService.getAgentPendingCashouts).toBe('function');
    });
  });
});

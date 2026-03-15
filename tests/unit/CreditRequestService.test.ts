/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CreditRequestService (Strengthened)
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

import { creditRequestService } from '../../src/services/CreditRequestService';

describe('CreditRequestService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getMyRequests', () => {
    it('should return empty array when no requests', async () => {
      const requests = await creditRequestService.getMyRequests('user-1');
      expect(requests).toEqual([]);
    });

    it('should not throw for unknown user', async () => {
      const requests = await creditRequestService.getMyRequests('nonexistent');
      expect(Array.isArray(requests)).toBe(true);
    });
  });

  describe('getPendingCount', () => {
    it('should return 0 when no pending requests', async () => {
      const count = await creditRequestService.getPendingCount('approver-1');
      expect(count).toBe(0);
    });

    it('should return a number type', async () => {
      const count = await creditRequestService.getPendingCount('approver-2');
      expect(typeof count).toBe('number');
    });
  });

  describe('export shape', () => {
    it('should export creditRequestService singleton', () => {
      expect(creditRequestService).toBeDefined();
      expect(typeof creditRequestService.getMyRequests).toBe('function');
      expect(typeof creditRequestService.getPendingCount).toBe('function');
    });

    it('should have submitRequest method', () => {
      expect(typeof creditRequestService.submitRequest).toBe('function');
    });

    it('should have approveRequest method', () => {
      expect(typeof creditRequestService.approveRequest).toBe('function');
    });

    it('should have rejectRequest method', () => {
      expect(typeof creditRequestService.rejectRequest).toBe('function');
    });
  });
});

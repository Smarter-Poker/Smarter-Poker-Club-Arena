/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CreditRequestService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests credit request workflow with mocked Supabase:
 * - getMyRequests: returns empty array when no data
 * - getPendingCount: returns 0 when no pending requests
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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { creditRequestService } from '../../src/services/CreditRequestService';

describe('CreditRequestService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET MY REQUESTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getMyRequests', () => {
    it('should return empty array when no requests', async () => {
      const requests = await creditRequestService.getMyRequests('user-1');
      expect(requests).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET PENDING COUNT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getPendingCount', () => {
    it('should return 0 when no pending requests', async () => {
      const count = await creditRequestService.getPendingCount('approver-1');
      expect(count).toBe(0);
    });
  });
});

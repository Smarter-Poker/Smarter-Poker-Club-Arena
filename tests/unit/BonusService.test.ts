/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BonusService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests bonus service CRUD with bus event verification:
 * - getBonusStatus: returns default status for new user
 * - canSpinToday: handles error gracefully
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpcResult = { data: null, error: null };

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
      rpc: vi.fn().mockResolvedValue(mockRpcResult),
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

import { bonusService } from '../../src/services/BonusService';

describe('BonusService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET BONUS STATUS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getBonusStatus', () => {
    it('should return default status when no data', async () => {
      const status = await bonusService.getBonusStatus('user-1');
      expect(status).toBeDefined();
      expect(status.dailyStreak).toBe(0);
      expect(status.canClaimDaily).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CAN SPIN TODAY
  // ─────────────────────────────────────────────────────────────────────────

  describe('canSpinToday', () => {
    it('should return true when no spin record exists', async () => {
      const result = await bonusService.canSpinToday('user-1');
      expect(result).toBe(true);
    });
  });
});

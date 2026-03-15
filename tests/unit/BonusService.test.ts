/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BonusService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
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
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalance: vi.fn().mockResolvedValue(0),
    credit: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { bonusService } from '../../src/services/BonusService';

describe('BonusService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getBonusStatus', () => {
    it('should return default status when no data', async () => {
      const status = await bonusService.getBonusStatus('user-1');
      expect(status).toBeDefined();
      expect(status.streak).toBe(0);
      expect(status.canClaimDaily).toBe(true);
    });

    it('should return a status object with expected shape', async () => {
      const status = await bonusService.getBonusStatus('user-2');
      expect(typeof status.streak).toBe('number');
      expect(typeof status.canClaimDaily).toBe('boolean');
    });
  });

  describe('canSpinToday', () => {
    it('should return true when no spin record exists', async () => {
      const result = await bonusService.canSpinToday('user-1');
      expect(result).toBe(true);
    });

    it('should not throw for empty userId', async () => {
      const result = await bonusService.canSpinToday('');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('claimDailyBonus', () => {
    it('should return a result when claiming', async () => {
      const result = await bonusService.claimDailyBonus('user-1');
      expect(result).toBeDefined();
    });
  });

  describe('export shape', () => {
    it('should export bonusService singleton with expected methods', () => {
      expect(typeof bonusService.getBonusStatus).toBe('function');
      expect(typeof bonusService.canSpinToday).toBe('function');
      expect(typeof bonusService.claimDailyBonus).toBe('function');
    });
  });
});

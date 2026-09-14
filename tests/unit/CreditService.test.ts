/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CreditService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Credit status calculation (utilization thresholds)
 * - Drawn credit, independent of credit capacity and wallet balance
 * - Prepaid agents have zero debt
 * - Next settlement date (always next Sunday)
 * - Grace period remaining logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the canonical identity boundary; these tests do not bootstrap authentication.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: true, authenticated: false, userId: null }),
}));

// ─── Mock dependencies ────────────────────────────────────────────────────

const creditRead = vi.hoisted(() => ({ data: null as any, error: null as any, select: vi.fn() }));
const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'select')
        return (columns: string) => {
          creditRead.select(columns);
          return new Proxy({}, handler);
        };
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: creditRead.data, error: creditRead.error });
      if (prop === 'then')
        return (resolve: (v: any) => void) =>
          resolve({ data: creditRead.data, error: creditRead.error });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { getBalance: vi.fn().mockResolvedValue(0) },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: { logWarning: vi.fn(), logCritical: vi.fn() },
}));

vi.mock('../../src/services/SettlementService', () => ({
  SettlementService: {},
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { CreditService } from '../../src/services/CreditService';

describe('CreditService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CREDIT STATUS CALCULATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateStatus', () => {
    it('should return frozen at 100% utilization', () => {
      expect(CreditService.calculateStatus(100)).toBe('frozen');
    });

    it('should return frozen above 100% utilization', () => {
      expect(CreditService.calculateStatus(150)).toBe('frozen');
    });

    it('should return suspended at 90% utilization', () => {
      expect(CreditService.calculateStatus(90)).toBe('suspended');
    });

    it('should return suspended at 95% utilization', () => {
      expect(CreditService.calculateStatus(95)).toBe('suspended');
    });

    it('should return warning at 75% utilization', () => {
      expect(CreditService.calculateStatus(75)).toBe('warning');
    });

    it('should return warning at 89% utilization', () => {
      expect(CreditService.calculateStatus(89)).toBe('warning');
    });

    it('should return good_standing below 75%', () => {
      expect(CreditService.calculateStatus(50)).toBe('good_standing');
    });

    it('should return good_standing at 0%', () => {
      expect(CreditService.calculateStatus(0)).toBe('good_standing');
    });

    it('should return good_standing at 74%', () => {
      expect(CreditService.calculateStatus(74)).toBe('good_standing');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEBT FORMULA
  // ─────────────────────────────────────────────────────────────────────────

  describe('drawn credit', () => {
    it('does not bill an unused credit line', async () => {
      creditRead.data = {
        credit_limit: 10000,
        credit_used: 0,
        agent_wallet_balance: 0,
        is_prepaid: false,
      };
      expect((await CreditService.calculateDebt('agent')).debtOwed).toBe(0);
      expect(creditRead.select).toHaveBeenCalledWith(expect.stringContaining('credit_used'));
    });
    it('preserves the debt even when the agent wallet exceeds the credit line', async () => {
      creditRead.data = {
        credit_limit: 10000,
        credit_used: 75.23,
        agent_wallet_balance: 20000,
        is_prepaid: false,
      };
      expect((await CreditService.calculateDebt('agent')).debtOwed).toBe(75.23);
    });
    it('uses drawn credit for each club agent', async () => {
      creditRead.data = [
        { id: 'a', credit_limit: 10000, credit_used: 25.17, agent_wallet_balance: 0 },
      ];
      expect((await CreditService.calculateClubDebt('club'))[0].debtOwed).toBe(25.17);
    });
    it('keeps prepaid accounts at zero debt', async () => {
      creditRead.data = {
        credit_limit: 10000,
        credit_used: 0,
        agent_wallet_balance: 0,
        is_prepaid: true,
      };
      expect((await CreditService.calculateDebt('agent')).debtOwed).toBe(0);
    });
    it.each([null, undefined, 'NaN', Infinity, -1])(
      'refuses unknown or invalid debt %s',
      async (value) => {
        creditRead.data = {
          credit_limit: 10000,
          credit_used: value,
          agent_wallet_balance: 0,
          is_prepaid: false,
        };
        await expect(CreditService.calculateDebt('agent')).rejects.toThrow(
          'Drawn credit is unavailable'
        );
      }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SETTLEMENT DATE
  // ─────────────────────────────────────────────────────────────────────────

  describe('getNextSettlementDate', () => {
    it('should return a valid ISO date string', () => {
      const date = CreditService.getNextSettlementDate();
      expect(() => new Date(date)).not.toThrow();
      expect(new Date(date).toISOString()).toBe(date);
    });

    it('should always point to a Sunday', () => {
      const date = new Date(CreditService.getNextSettlementDate());
      expect(date.getDay()).toBe(0); // 0 = Sunday
    });

    it('should set time to 23:59:59', () => {
      const date = new Date(CreditService.getNextSettlementDate());
      expect(date.getHours()).toBe(23);
      expect(date.getMinutes()).toBe(59);
      expect(date.getSeconds()).toBe(59);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACE PERIOD
  // ─────────────────────────────────────────────────────────────────────────

  describe('getGracePeriodRemaining', () => {
    it('should return a number >= 0', () => {
      const remaining = CreditService.getGracePeriodRemaining();
      expect(remaining).toBeGreaterThanOrEqual(0);
    });

    it('should return <= 48 hours max', () => {
      const remaining = CreditService.getGracePeriodRemaining();
      expect(remaining).toBeLessThanOrEqual(48);
    });
  });
});

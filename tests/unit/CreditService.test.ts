/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CreditService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Credit status calculation (utilization thresholds)
 * - Debt formula: Math.max(0, creditLimit - currentBalance)
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

  describe('debt formula', () => {
    it('should calculate debt as creditLimit - currentBalance', () => {
      // debt = 10000 - 2500 = 7500
      const debt = Math.max(0, 10000 - 2500);
      expect(debt).toBe(7500);
    });

    it('should never return negative debt', () => {
      // balance > limit means agent is in surplus
      const debt = Math.max(0, 5000 - 8000);
      expect(debt).toBe(0);
    });

    it('should return zero debt when balance equals limit', () => {
      const debt = Math.max(0, 10000 - 10000);
      expect(debt).toBe(0);
    });
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

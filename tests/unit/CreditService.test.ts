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
import { supabase } from '../../src/lib/supabase';

describe('CreditService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('payment receipts', () => {
    it('submits the preserved operation identity and returns only the confirmed amount', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: {
          ok: true,
          amount: 12.34,
          payment: { id: 'receipt', transaction_id: 'operation', created_at: '2026-09-14T09:00Z' },
        },
        error: null,
      } as any);
      const receipt = await CreditService.processPayment('invoice', 12.34, 'wallet', {
        operationId: 'operation',
      });
      expect(supabase.rpc).toHaveBeenCalledWith('fn_process_credit_invoice_payment', {
        p_invoice_id: 'invoice',
        p_amount: 12.34,
        p_method: 'wallet',
        p_operation_id: 'operation',
        p_reference: null,
      });
      expect(receipt).toMatchObject({ id: 'receipt', amount: 12.34, transactionId: 'operation' });
    });
    it('does not substitute the requested amount for an incomplete receipt', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { ok: true }, error: null } as any);
      await expect(CreditService.processPayment('invoice', 12.34, 'wallet')).rejects.toThrow(
        'receipt is incomplete'
      );
    });
    it.each([NaN, Infinity, -1, 0, 1.001])(
      'refuses an invalid payment amount %s before sending it',
      async (amount) => {
        await expect(CreditService.processPayment('invoice', amount, 'wallet')).rejects.toThrow(
          'positive amount'
        );
        expect(supabase.rpc).not.toHaveBeenCalled();
      }
    );
  });

  describe('invoice receipts', () => {
    const invoice = (overrides: Record<string, unknown> = {}) => ({
      id: 'invoice',
      agent_id: 'agent',
      period_start: '2026-09-21T00:00:00.000Z',
      period_end: '2026-09-27T00:00:00.000Z',
      debt_owed: '1599.99',
      amount_paid: '300.00',
      amount_remaining: '1299.99',
      status: 'partial',
      due_date: '2026-10-01T00:00:00.000Z',
      created_at: '2026-09-28T00:00:00.000Z',
      paid_at: null,
      ...overrides,
    });

    it('normalizes the validated database receipt into finite chip amounts', () => {
      expect(CreditService.mapInvoice(invoice(), 'Agent')).toMatchObject({
        debtOwed: 1599.99,
        amountPaid: 300,
        amountRemaining: 1299.99,
        status: 'partial',
        paidAt: undefined,
      });
    });

    it.each([
      { status: 'unknown' },
      { amount_paid: undefined },
      { amount_remaining: undefined },
      { amount_remaining: 'NaN' },
      { amount_paid: -1 },
      { debt_owed: 1.001 },
      { debt_owed: 1600 },
      { status: 'paid', amount_paid: 300, amount_remaining: 0 },
      { status: 'partial', amount_paid: 0, amount_remaining: 1599.99 },
      { status: 'pending', amount_paid: 300, amount_remaining: 1299.99 },
      { status: 'overdue', amount_paid: 1599.99, amount_remaining: 0 },
      { due_date: 'not-a-date' },
      { id: '' },
    ])('refuses a malformed invoice receipt %#', (override) => {
      expect(() => CreditService.mapInvoice(invoice(override), 'Agent')).toThrow(/Invoice/);
    });

    it('accepts a cancelled invoice only when its remaining balance is zero', () => {
      expect(
        CreditService.mapInvoice(
          invoice({ status: 'void', amount_paid: '0.00', amount_remaining: '0.00' }),
          'Agent'
        )
      ).toMatchObject({ status: 'void', debtOwed: 1599.99, amountPaid: 0, amountRemaining: 0 });
      expect(() =>
        CreditService.mapInvoice(
          invoice({ status: 'void', amount_paid: '0.00', amount_remaining: '1599.99' }),
          'Agent'
        )
      ).toThrow(/Invoice/);
    });
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

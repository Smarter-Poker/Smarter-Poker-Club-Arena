/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FinancialAlertService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - logCritical routes to the fn_raise_financial_alert RPC with p_severity='critical'
 * - logWarning routes to the same RPC with p_severity='warning'
 * - raise() correctly delegates to logCritical or logWarning
 * - FINANCIAL_ALERT bus event emission
 * - AUDIT M7: an unpersisted CRITICAL is NEVER swallowed — it escalates to
 *   reportError. This is the whole point of the M7 fix: financial_alerts has
 *   service_role-only RLS, so the old bare .insert() silently dropped 100% of
 *   client alerts. The regression guard below is what keeps that from
 *   reappearing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: () => ({
      insert: (...args: any[]) => {
        mockInsert(...args);
        return Promise.resolve({ error: null });
      },
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

const mockBusEmit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => mockBusEmit(...args),
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

const mockReportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: any[]) => mockReportError(...args),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { FinancialAlertService } from '../../src/services/FinancialAlertService';

const OK_ALERT_ID = 'e5c57cd1-2124-4fb3-ba3d-0bab5efda35a';

describe('FinancialAlertService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the RPC persists successfully and returns the new alert id.
    mockRpc.mockResolvedValue({ data: OK_ALERT_ID, error: null });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOG CRITICAL
  // ─────────────────────────────────────────────────────────────────────────

  describe('logCritical', () => {
    it('should raise the alert through fn_raise_financial_alert with p_severity=critical', async () => {
      await FinancialAlertService.logCritical('TestService', 'Test critical error', {
        key: 'value',
      });

      expect(mockRpc).toHaveBeenCalledWith(
        'fn_raise_financial_alert',
        expect.objectContaining({
          p_severity: 'critical',
          p_source: 'TestService',
          p_message: 'Test critical error',
          p_context: expect.objectContaining({ key: 'value' }),
        })
      );
    });

    it('should NOT write to financial_alerts directly (RLS is service_role only)', async () => {
      await FinancialAlertService.logCritical('TestService', 'Test critical error', {});

      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('should emit FINANCIAL_ALERT bus event', async () => {
      await FinancialAlertService.logCritical('CreditService', 'Wallet rollback failed', {});

      expect(mockBusEmit).toHaveBeenCalledWith(
        'FINANCIAL_ALERT',
        expect.objectContaining({
          severity: 'critical',
          source: 'CreditService',
          message: 'Wallet rollback failed',
        })
      );
    });

    it('should not escalate when the RPC persists the alert', async () => {
      await FinancialAlertService.logCritical('TestService', 'Persisted fine', {});

      expect(mockReportError).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOG WARNING
  // ─────────────────────────────────────────────────────────────────────────

  describe('logWarning', () => {
    it('should raise the alert through fn_raise_financial_alert with p_severity=warning', async () => {
      await FinancialAlertService.logWarning('ChipFlowService', 'Large transfer detected', {
        amount: 75000,
      });

      expect(mockRpc).toHaveBeenCalledWith(
        'fn_raise_financial_alert',
        expect.objectContaining({
          p_severity: 'warning',
          p_source: 'ChipFlowService',
          p_message: 'Large transfer detected',
        })
      );
    });

    it('should emit FINANCIAL_ALERT bus event with warning severity', async () => {
      await FinancialAlertService.logWarning('TestService', 'Test warning', {});

      expect(mockBusEmit).toHaveBeenCalledWith(
        'FINANCIAL_ALERT',
        expect.objectContaining({ severity: 'warning' })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAISE (ROUTING)
  // ─────────────────────────────────────────────────────────────────────────

  describe('raise', () => {
    it('should route critical severity to logCritical', async () => {
      await FinancialAlertService.raise('critical', 'Critical issue', 'TestSource', {});

      expect(mockRpc).toHaveBeenCalledWith(
        'fn_raise_financial_alert',
        expect.objectContaining({ p_severity: 'critical' })
      );
    });

    it('should route warning severity to logWarning', async () => {
      await FinancialAlertService.raise('warning', 'Warning issue', 'TestSource', {});

      expect(mockRpc).toHaveBeenCalledWith(
        'fn_raise_financial_alert',
        expect.objectContaining({ p_severity: 'warning' })
      );
    });

    it('should route info severity to logWarning (persisted as warning)', async () => {
      await FinancialAlertService.raise('info', 'Info message', 'TestSource', {});

      // Info falls to the else clause -> logWarning -> _log('warning', ...)
      // So the RPC receives p_severity='warning', NOT 'info'.
      expect(mockRpc).toHaveBeenCalledWith(
        'fn_raise_financial_alert',
        expect.objectContaining({ p_severity: 'warning', p_message: 'Info message' })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACEFUL FAILURE + AUDIT M7 ESCALATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('graceful failure handling', () => {
    it('should not throw when the RPC rejects', async () => {
      mockRpc.mockRejectedValueOnce(new Error('DB connection error'));

      await expect(
        FinancialAlertService.logCritical('TestService', 'Test', {})
      ).resolves.not.toThrow();
    });

    it('should not throw when the RPC returns an error payload', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '28000', message: 'auth' } });

      await expect(
        FinancialAlertService.logWarning('TestService', 'Test', {})
      ).resolves.not.toThrow();
    });

    it('should still emit bus event even if the RPC fails', async () => {
      mockRpc.mockRejectedValueOnce(new Error('DB timeout'));

      await FinancialAlertService.logWarning('TestService', 'Test', {});

      expect(mockBusEmit).toHaveBeenCalled();
    });

    it('AUDIT M7: an unpersisted CRITICAL escalates to reportError', async () => {
      const rpcError = { code: '42501', message: 'permission denied for table financial_alerts' };
      mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

      await FinancialAlertService.logCritical('CreditService', 'Wallet rollback failed', {
        invoiceId: 'inv-1',
      });

      expect(mockReportError).toHaveBeenCalledWith(
        rpcError,
        'FinancialAlertService.CRITICAL_ALERT_UNPERSISTED',
        expect.objectContaining({
          severity: 'critical',
          source: 'CreditService',
          message: 'Wallet rollback failed',
        })
      );
    });

    it('AUDIT M7: a THROTTLED CRITICAL (null id, no error) also escalates', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      await FinancialAlertService.logCritical('CashoutService', 'Throttled critical', {});

      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        'FinancialAlertService.CRITICAL_ALERT_UNPERSISTED',
        expect.objectContaining({ severity: 'critical', source: 'CashoutService' })
      );
    });

    it('AUDIT M7: a thrown RPC on a CRITICAL escalates rather than being swallowed', async () => {
      const thrown = new Error('network down');
      mockRpc.mockRejectedValueOnce(thrown);

      await FinancialAlertService.logCritical('TestService', 'Test', {});

      expect(mockReportError).toHaveBeenCalledWith(
        thrown,
        'FinancialAlertService.CRITICAL_ALERT_UNPERSISTED',
        expect.objectContaining({ severity: 'critical' })
      );
    });

    it('should NOT escalate a failed WARNING to reportError', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

      await FinancialAlertService.logWarning('TestService', 'Test', {});

      expect(mockReportError).not.toHaveBeenCalled();
    });

    it('should still emit the bus event when a CRITICAL fails to persist', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

      await FinancialAlertService.logCritical('TestService', 'Test', {});

      expect(mockBusEmit).toHaveBeenCalledWith(
        'FINANCIAL_ALERT',
        expect.objectContaining({ severity: 'critical' })
      );
    });
  });
});

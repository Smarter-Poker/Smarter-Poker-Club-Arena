/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FinancialAlertService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - logCritical routes to _log with severity='critical'
 * - logWarning routes to _log with severity='warning'
 * - raise() method correctly delegates to logCritical or logWarning
 * - FINANCIAL_ALERT bus event emission
 * - Graceful handling if DB insert fails
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { FinancialAlertService } from '../../src/services/FinancialAlertService';

describe('FinancialAlertService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOG CRITICAL
  // ─────────────────────────────────────────────────────────────────────────

  describe('logCritical', () => {
    it('should insert alert with severity=critical to database', async () => {
      await FinancialAlertService.logCritical('TestService', 'Test critical error', {
        key: 'value',
      });

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          source: 'TestService',
          message: 'Test critical error',
        })
      );
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
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOG WARNING
  // ─────────────────────────────────────────────────────────────────────────

  describe('logWarning', () => {
    it('should insert alert with severity=warning to database', async () => {
      await FinancialAlertService.logWarning('ChipFlowService', 'Large transfer detected', {
        amount: 75000,
      });

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'warning',
          source: 'ChipFlowService',
          message: 'Large transfer detected',
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

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    });

    it('should route warning severity to logWarning', async () => {
      await FinancialAlertService.raise('warning', 'Warning issue', 'TestSource', {});

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
    });

    it('should route info severity to logWarning', async () => {
      await FinancialAlertService.raise('info', 'Info message', 'TestSource', {});

      // Info falls to the else clause, which calls logWarning
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'info' }));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACEFUL FAILURE
  // ─────────────────────────────────────────────────────────────────────────

  describe('graceful failure handling', () => {
    it('should not throw when DB insert fails', async () => {
      mockInsert.mockRejectedValueOnce(new Error('DB connection error'));

      // Should not throw — logs to console as fallback
      await expect(
        FinancialAlertService.logCritical('TestService', 'Test', {})
      ).resolves.not.toThrow();
    });

    it('should still emit bus event even if DB insert fails', async () => {
      mockInsert.mockRejectedValueOnce(new Error('DB timeout'));

      await FinancialAlertService.logWarning('TestService', 'Test', {});

      // Bus event should still fire
      expect(mockBusEmit).toHaveBeenCalled();
    });
  });
});

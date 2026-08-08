/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FinancialCronService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests automated financial health checks:
 * - start/stop lifecycle
 * - Config defaults (24h reconciliation, 6h suspension)
 * - getStatus reporting
 * - logRateChange audit trail
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the M4 tests can assert which tables the client touches.
const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

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
    from: (table: string) => {
      mockFrom(table);
      return buildChain();
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/services/ChipFlowService', () => ({
  ChipFlowService: {
    runReconciliation: vi.fn().mockResolvedValue({ isBalanced: true, difference: 0 }),
  },
}));

vi.mock('../../src/services/CreditService', () => ({
  CreditService: {
    checkSuspension: vi.fn().mockResolvedValue({ shouldSuspend: false }),
    suspendAgent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logWarning: vi.fn().mockResolvedValue(undefined),
    logCritical: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { FinancialCronService } from '../../src/services/FinancialCronService';

describe('FinancialCronService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    FinancialCronService.stop(); // Ensure clean state
  });

  afterEach(() => {
    FinancialCronService.stop();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  describe('start/stop lifecycle', () => {
    it('should set isRunning to true on start', () => {
      FinancialCronService.start();
      expect(FinancialCronService._isRunning).toBe(true);
    });

    it('should set isRunning to false on stop', () => {
      FinancialCronService.start();
      FinancialCronService.stop();
      expect(FinancialCronService._isRunning).toBe(false);
    });

    it('should clear all timers on stop', () => {
      FinancialCronService.start();
      FinancialCronService.stop();
      expect(FinancialCronService._reconciliationTimer).toBeNull();
      expect(FinancialCronService._suspensionTimer).toBeNull();
      expect(FinancialCronService._disputeEscalationTimer).toBeNull();
      expect(FinancialCronService._startupTimer).toBeNull();
    });

    it('should stop previous run when started again', () => {
      FinancialCronService.start();
      const firstTimer = FinancialCronService._suspensionTimer;
      FinancialCronService.start(); // Restart
      expect(FinancialCronService._suspensionTimer).not.toBe(firstTimer);
    });

    it('does not schedule a reconciliation timer at all (AUDIT M4)', () => {
      // The browser cannot reconcile a chip supply it can only see one row of.
      // Scheduling it here is what produced 1,039 false failures over 5 months.
      FinancialCronService.start();
      expect(FinancialCronService._reconciliationTimer).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG DEFAULTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('config defaults', () => {
    it('should default reconciliation to 24 hours', () => {
      FinancialCronService.start();
      expect(FinancialCronService._config.reconciliationIntervalMs).toBe(24 * 60 * 60 * 1000);
    });

    it('should default suspension check to 6 hours', () => {
      FinancialCronService.start();
      expect(FinancialCronService._config.suspensionCheckIntervalMs).toBe(6 * 60 * 60 * 1000);
    });

    it('should default autoSuspend to false', () => {
      FinancialCronService.start();
      expect(FinancialCronService._config.autoSuspendEnabled).toBe(false);
    });

    it('should accept custom config', () => {
      FinancialCronService.start({
        reconciliationIntervalMs: 1000,
        suspensionCheckIntervalMs: 2000,
        autoSuspendEnabled: true,
      });
      expect(FinancialCronService._config.reconciliationIntervalMs).toBe(1000);
      expect(FinancialCronService._config.suspensionCheckIntervalMs).toBe(2000);
      expect(FinancialCronService._config.autoSuspendEnabled).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET STATUS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('should report running state', () => {
      FinancialCronService.start();
      const status = FinancialCronService.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.config.reconciliationIntervalMs).toBe(24 * 60 * 60 * 1000);
    });

    it('should report stopped state', () => {
      const status = FinancialCronService.getStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('runReconciliation', () => {
    it('reports itself unavailable rather than guessing (AUDIT M4)', async () => {
      // The distinction that matters: "the books do not balance" and "this
      // process is not in a position to know" are different answers, and
      // conflating them is what filled the ops table with noise.
      const result = await FinancialCronService.runReconciliation();
      expect(result.unavailable).toBe(true);
      expect(result.difference).toBe(0);
      expect(result.checkedAt).toBeTruthy();
    });

    it('writes nothing anywhere (AUDIT M4)', async () => {
      // financial_health_checks is service_role-write-only as of the M4
      // migration, so an attempt would 42501 - but the client should not be
      // attempting it in the first place.
      mockFrom.mockClear();
      await FinancialCronService.runReconciliation();
      const touched = mockFrom.mock.calls.map((c: unknown[]) => c[0]);
      expect(touched).not.toContain('financial_health_checks');
      expect(touched).not.toContain('wallets');
      expect(touched).not.toContain('wallet_transactions');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ESCALATE STALE DISPUTES (72h SLA)
  // ─────────────────────────────────────────────────────────────────────────

  describe('escalateStaleDisputes', () => {
    it('should return 0 when no stale disputes', async () => {
      const count = await FinancialCronService.escalateStaleDisputes();
      expect(count).toBe(0);
    });
  });
});

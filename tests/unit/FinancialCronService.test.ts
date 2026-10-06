/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FinancialCronService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the on-demand financial health checks:
 * - nothing is scheduled in a browser (no start/stop, no timers)
 * - a signed-out caller never reads agents
 * - getStatus reporting
 * - reconciliation is server-side
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Isolate the canonical identity boundary; these tests do not bootstrap authentication.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: true, authenticated: false, userId: null }),
}));

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
import { supabase } from '../../src/lib/supabase';

describe('FinancialCronService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses the retired weekly payout without reading clubs or moving money', async () => {
    await expect(FinancialCronService.settleAllClubRakebacks()).rejects.toThrow(
      'Weekly Accounting Is Automatic'
    );
    expect(mockFrom).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // NO BROWSER SCHEDULE (2026-10-05)
  // ─────────────────────────────────────────────────────────────────

  describe('no financial schedule runs in a browser', () => {
    /* ServiceBootstrap started this in every tab: a suspension scan of
       `agents` 30s after load and every six hours, under whoever had the tab
       open - signed out included, which is where the four "permission denied
       for table agents" errors of 2026-10-05 came from. */
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const cronSrc = strip(
      readFileSync(resolve(__dirname, '../../src/services/FinancialCronService.ts'), 'utf8')
    );
    const bootSrc = strip(
      readFileSync(resolve(__dirname, '../../src/services/ServiceBootstrap.ts'), 'utf8')
    );

    it('has no start, no stop and no timer of any kind', () => {
      const service = FinancialCronService as Record<string, unknown>;
      expect(service.start).toBeUndefined();
      expect(service.stop).toBeUndefined();
      expect(cronSrc).not.toMatch(/\bsetInterval\(|\bsetTimeout\(/);
    });

    it('boot never imports or starts it', () => {
      expect(bootSrc).not.toContain('FinancialCronService');
    });

    it('a signed-out caller is refused before any read of agents', async () => {
      // IdentityDNA is mocked signed out (authenticated: false) for this file.
      mockFrom.mockClear();
      const result = await FinancialCronService.runSuspensionCheck();
      expect(result.unavailable).toBe(true);
      expect(result.agentsChecked).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GET STATUS
  // ─────────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('reports log-only and no schedule', () => {
      const status = FinancialCronService.getStatus() as Record<string, unknown>;
      expect(status.isRunning).toBeUndefined();
      expect(FinancialCronService.getStatus().config).toEqual({ autoSuspendEnabled: false });
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

  describe('dispute escalation is retired', () => {
    it('the browser has no dispute escalation entry point at all', () => {
      // Measured 2026-09-19: authenticated has no UPDATE grant on
      // public.disputes and the table's only policy is SELECT, so this method
      // was 42501 on every call while still incrementing its own counter and
      // persisting a "dispute auto-escalated" alert through
      // fn_raise_financial_alert, which authenticated CAN execute.
      expect(
        (FinancialCronService as Record<string, unknown>).escalateStaleDisputes
      ).toBeUndefined();
    });
  });
});

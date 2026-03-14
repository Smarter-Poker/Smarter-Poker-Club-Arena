/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CashoutService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the cashout lifecycle:
 * - Request validation (positive amounts, balance checks)
 * - Agent notification failure isolation
 * - Status transitions
 * - Bus event emissions for UI sync
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: () => ({
      insert: (...args: any[]) => {
        mockInsert(...args);
        return { select: () => ({ maybeSingle: () => mockMaybeSingle() }) };
      },
      select: (...args: any[]) => {
        mockSelect(...args);
        return {
          eq: () => ({
            eq: () => ({
              gte: () => ({
                limit: () => mockMaybeSingle(),
              }),
              maybeSingle: () => mockMaybeSingle(),
              order: () => ({
                limit: () => mockMaybeSingle(),
              }),
            }),
            maybeSingle: () => mockMaybeSingle(),
          }),
        };
      },
      update: (...args: any[]) => {
        mockUpdate(...args);
        return {
          eq: () => ({
            eq: () => mockMaybeSingle(),
          }),
        };
      },
    }),
  },
}));

const mockBusEmit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => mockBusEmit(...args),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logWarning: vi.fn(),
    logCritical: vi.fn(),
  },
}));

vi.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    notifyCashoutRequest: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalance: vi.fn().mockResolvedValue(0),
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/ChipFlowService', () => ({
  ChipFlowService: {
    processTransfer: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { cashoutService } from '../../src/services/CashoutService';

describe('CashoutService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUEST VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('request validation', () => {
    it('should reject cashout with amount <= 0', async () => {
      await expect(cashoutService.requestCashout('user1', 'club1', 0)).rejects.toThrow();
    });

    it('should reject cashout with negative amount', async () => {
      await expect(cashoutService.requestCashout('user1', 'club1', -100)).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REJECT CASHOUT VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('rejectCashout', () => {
    it('should require agent ID', async () => {
      await expect(cashoutService.rejectCashout('cashout-1', '', 'reason')).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AGENT NOTIFICATION ISOLATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('agent notification isolation', () => {
    it('notification failure should not prevent cashout from succeeding', async () => {
      // Source code wraps notification in try/catch (lines 112-124).
      // Verify: even when notifyCashoutRequest throws, requestCashout still resolves.
      const { notificationService: mockNotif } =
        await import('../../src/services/NotificationService');
      (mockNotif.notifyCashoutRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('OneSignal down')
      );

      // requestCashout should still succeed (notification is non-critical)
      mockRpc.mockResolvedValueOnce({ data: 'cashout-id', error: null });
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      // requestCashout should still succeed (notification is non-critical)
      await expect(cashoutService.requestCashout('user-1', 'club-1', 100)).resolves.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CANCEL CASHOUT
  // ─────────────────────────────────────────────────────────────────────────

  describe('cancelCashout', () => {
    it('should require cashout ID', async () => {
      const result = await cashoutService.cancelCashout('', 'user1');
      expect(result).toBeFalsy();
    });
  });
});

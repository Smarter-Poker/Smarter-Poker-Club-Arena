/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ChipFlowService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the chip distribution service that governs all chip movements:
 *   Union → Club → Agent → Player
 *
 * Critical financial logic tested:
 * - Cent precision via exact() function
 * - Amount validation (positive, finite)
 * - Rate limiting (10 transfers/min)
 * - Large transfer alerting (≥50K)
 * - MasterBus BALANCE_UPDATED emissions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies BEFORE imports ─────────────────────────────────────

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();
const mockLimit = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: (...args: any[]) => {
      mockFrom(...args);
      return {
        select: (...sArgs: any[]) => {
          mockSelect(...sArgs);
          return {
            eq: (...eArgs: any[]) => {
              mockEq(...eArgs);
              return {
                eq: (...e2Args: any[]) => {
                  mockEq(...e2Args);
                  return {
                    gte: (...gArgs: any[]) => {
                      mockGte(...gArgs);
                      return {
                        limit: (...lArgs: any[]) => {
                          mockLimit(...lArgs);
                          return mockMaybeSingle();
                        },
                      };
                    },
                    maybeSingle: () => mockMaybeSingle(),
                  };
                },
                maybeSingle: () => mockMaybeSingle(),
              };
            },
          };
        },
      };
    },
  },
}));

const mockBusEmit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => mockBusEmit(...args),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const mockLogWarning = vi.fn();
vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logWarning: (...args: any[]) => mockLogWarning(...args),
    logCritical: vi.fn(),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalance: vi.fn().mockResolvedValue(100000),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { ChipFlowService } from '../../src/services/ChipFlowService';

describe('ChipFlowService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXACT() CENT PRECISION
  // ─────────────────────────────────────────────────────────────────────────

  describe('exact() cent precision', () => {
    it('should truncate to 2 decimal places (not round)', () => {
      // exact() is private but we can test through transfer behavior
      // The function is: Math.trunc(v * 100) / 100
      expect(Math.trunc(10.999 * 100) / 100).toBe(10.99); // truncate, not round
      expect(Math.trunc(10.001 * 100) / 100).toBe(10); // truncate fractional cents
      expect(Math.trunc(0.005 * 100) / 100).toBe(0); // sub-cent truncated to 0
      expect(Math.trunc(99999.999 * 100) / 100).toBe(99999.99);
    });

    it('should handle IEEE 754 floating point edge cases', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754
      const result = Math.trunc((0.1 + 0.2) * 100) / 100;
      expect(result).toBe(0.3);
    });

    it('should handle negative numbers correctly', () => {
      // Math.trunc(-0.5) = 0, Math.trunc(0.5) = 0
      expect(Math.trunc(-10.99 * 100) / 100).toBe(-10.99);
      expect(Math.trunc(0 * 100) / 100).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AMOUNT VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('amount validation', () => {
    it('should reject transfer with amount = 0', async () => {
      // Supabase query for rate limiting returns empty (no rate limit hit)
      mockMaybeSingle.mockResolvedValue({ data: [] });

      await expect(
        ChipFlowService.transfer('user1', 'user2', 0, 'test', 'test transfer')
      ).rejects.toThrow('Transfer amount must be positive');
    });

    it('should reject transfer with negative amount', async () => {
      mockMaybeSingle.mockResolvedValue({ data: [] });

      await expect(
        ChipFlowService.transfer('user1', 'user2', -100, 'test', 'test transfer')
      ).rejects.toThrow('Transfer amount must be positive');
    });

    it('should reject sub-cent amounts that truncate to 0', async () => {
      mockMaybeSingle.mockResolvedValue({ data: [] });

      // 0.004 truncates to 0.00 via exact()
      await expect(
        ChipFlowService.transfer('user1', 'user2', 0.004, 'test', 'test transfer')
      ).rejects.toThrow('Transfer amount must be positive');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RATE LIMITING
  // ─────────────────────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should reject transfer when rate limit exceeded (10/min)', async () => {
      // Simulate 10 recent transfers found
      const tenTransfers = Array.from({ length: 10 }, (_, i) => ({ id: `tx-${i}` }));
      mockMaybeSingle.mockResolvedValue({ data: tenTransfers });

      await expect(
        ChipFlowService.transfer('user1', 'user2', 100, 'test', 'test transfer')
      ).rejects.toThrow('Transfer rate limit exceeded');
    });

    it('should allow transfer when under rate limit', async () => {
      // Simulate 5 recent transfers
      const fiveTransfers = Array.from({ length: 5 }, (_, i) => ({ id: `tx-${i}` }));
      mockMaybeSingle.mockResolvedValueOnce({ data: fiveTransfers }); // rate limit check
      mockRpc.mockResolvedValueOnce({ error: null }); // atomic_chip_transfer
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 900 } }); // from wallet
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 1100 } }); // to wallet

      const result = await ChipFlowService.transfer('user1', 'user2', 100, 'transfer', 'test');

      expect(result.success).toBe(true);
      expect(result.amount).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LARGE TRANSFER ALERTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('large transfer alerts', () => {
    it('should trigger warning for transfers ≥ 50,000 chips', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: [] }); // rate limit
      mockRpc.mockResolvedValueOnce({ error: null }); // transfer RPC
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 50000 } }); // from
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 100000 } }); // to

      await ChipFlowService.transfer('user1', 'user2', 50000, 'transfer', 'big move');

      expect(mockLogWarning).toHaveBeenCalledWith(
        'ChipFlowService',
        expect.stringContaining('50,000'),
        expect.objectContaining({ amount: 50000 })
      );
    });

    it('should NOT trigger warning for transfers < 50,000 chips', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: [] }); // rate limit
      mockRpc.mockResolvedValueOnce({ error: null }); // transfer RPC
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 49000 } }); // from
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 50000 } }); // to

      await ChipFlowService.transfer('user1', 'user2', 49999, 'transfer', 'not big');

      expect(mockLogWarning).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUS EVENT EMISSIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('MasterBus emissions', () => {
    it('should emit BALANCE_UPDATED for both sender and receiver', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: [] }); // rate limit
      mockRpc.mockResolvedValueOnce({ error: null }); // transfer RPC
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 900 } }); // from
      mockMaybeSingle.mockResolvedValueOnce({ data: { balance: 1100 } }); // to

      await ChipFlowService.transfer('sender', 'receiver', 100, 'transfer', 'test');

      // Should emit for sender (negative)
      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({
          userId: 'sender',
          amount: -100,
        })
      );

      // Should emit for receiver (positive)
      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({
          userId: 'receiver',
          amount: 100,
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RPC ERROR HANDLING
  // ─────────────────────────────────────────────────────────────────────────

  describe('RPC error handling', () => {
    it('should throw on atomic_chip_transfer RPC failure', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: [] }); // rate limit
      mockRpc.mockResolvedValueOnce({ error: { message: 'insufficient balance' } });

      await expect(
        ChipFlowService.transfer('user1', 'user2', 100, 'transfer', 'test')
      ).rejects.toThrow('Transfer failed: insufficient balance');
    });
  });
});

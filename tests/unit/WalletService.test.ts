/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — WalletService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the Triple-Wallet (BUSINESS/PLAYER/PROMO) service covering:
 * - Amount validation on all mutation operations
 * - Same-wallet transfer rejection
 * - Promo distribution guards
 * - Bus event emissions for UI refresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockFromChain = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => mockFromChain(),
          }),
          maybeSingle: () => mockFromChain(),
        }),
      }),
      insert: () => ({
        select: () => ({
          maybeSingle: () => mockFromChain(),
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
  },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logWarning: vi.fn(),
    logCritical: vi.fn(),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { WalletService } from '../../src/services/WalletService';

describe('WalletService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INTERNAL TRANSFER VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('internalTransfer', () => {
    it('should reject amount <= 0', async () => {
      await expect(
        WalletService.internalTransfer('user1', {
          fromWallet: 'BUSINESS',
          toWallet: 'PLAYER',
          amount: 0,
        })
      ).rejects.toThrow('Transfer amount must be positive');
    });

    it('should reject negative amounts', async () => {
      await expect(
        WalletService.internalTransfer('user1', {
          fromWallet: 'BUSINESS',
          toWallet: 'PLAYER',
          amount: -50,
        })
      ).rejects.toThrow('Transfer amount must be positive');
    });

    it('should reject same-wallet transfers', async () => {
      await expect(
        WalletService.internalTransfer('user1', {
          fromWallet: 'PLAYER',
          toWallet: 'PLAYER',
          amount: 100,
        })
      ).rejects.toThrow('Cannot transfer to same wallet');
    });

    it('should emit BALANCE_UPDATED on successful transfer', async () => {
      // fn_wallet_type_transfer returns jsonb { success: true } on success.
      mockRpc.mockResolvedValueOnce({ data: { success: true }, error: null });
      mockFromChain.mockResolvedValue({ data: null, error: null }); // log transactions

      await WalletService.internalTransfer('user1', {
        fromWallet: 'BUSINESS',
        toWallet: 'PLAYER',
        amount: 100,
      });

      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({
          source: 'internal_transfer',
          userId: 'user1',
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRANSFER TO USER
  // ─────────────────────────────────────────────────────────────────────────

  describe('transferToUser', () => {
    it('should reject amount <= 0', async () => {
      await expect(WalletService.transferToUser('user1', 'user2', 0)).rejects.toThrow(
        'Transfer amount must be positive'
      );
    });

    it('should reject negative amounts', async () => {
      await expect(WalletService.transferToUser('user1', 'user2', -100)).rejects.toThrow(
        'Transfer amount must be positive'
      );
    });

    it('should emit BALANCE_UPDATED for both sender and receiver', async () => {
      mockRpc.mockResolvedValueOnce({ error: null }); // atomic_wallet_transfer
      mockFromChain.mockResolvedValue({ data: null, error: null }); // log transactions

      await WalletService.transferToUser('sender', 'receiver', 100);

      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({ source: 'transfer_sent', userId: 'sender' })
      );
      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({ source: 'transfer_received', userId: 'receiver' })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROMO DISTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('distributePromo', () => {
    it('should reject amount <= 0', async () => {
      await expect(WalletService.distributePromo('agent1', 'player1', 0)).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('should reject negative amounts', async () => {
      await expect(WalletService.distributePromo('agent1', 'player1', -50)).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('should emit BALANCE_UPDATED for the player on success', async () => {
      mockRpc.mockResolvedValueOnce({ error: null }); // distribute_promo_chips

      await WalletService.distributePromo('agent1', 'player1', 500);

      expect(mockBusEmit).toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.objectContaining({ source: 'promo', userId: 'player1' })
      );
    });

    it('should throw on RPC failure', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'insufficient promo balance' } });

      await expect(WalletService.distributePromo('agent1', 'player1', 500)).rejects.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BULK PROMO
  // ─────────────────────────────────────────────────────────────────────────

  describe('bulkDistributePromo', () => {
    it('should count successes and failures separately', async () => {
      // First two succeed, third fails
      mockRpc
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: 'failed' } });

      const result = await WalletService.bulkDistributePromo('agent1', [
        { playerId: 'p1', amount: 100 },
        { playerId: 'p2', amount: 200 },
        { playerId: 'p3', amount: 300 },
      ]);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LOCK FOR BUY-IN
  // ─────────────────────────────────────────────────────────────────────────

  describe('lockForBuyIn', () => {
    it('should call atomic_deduct_wallet_and_log RPC', async () => {
      mockRpc.mockResolvedValueOnce({ data: true, error: null });

      await WalletService.lockForBuyIn('user1', 'table-123', 500);

      expect(mockRpc).toHaveBeenCalledWith('atomic_deduct_wallet_and_log', {
        p_user_id: 'user1',
        p_amount: 500,
        p_category: 'buyin',
        p_description: 'Cash game buy-in at table',
        p_table_id: 'table-123',
        p_hand_id: null,
        p_related_entity_id: null,
      });
    });
  });

  describe('no client-side wallet credit (AUDIT M17 regression guard)', () => {
    it('no longer exposes unlockFromTable', () => {
      // This was the cash-out mint: it credited the PLAYER wallet with the
      // amount the player typed into the Cashier, through a generic credit RPC,
      // with no seat-stack decrement anywhere on the path. Table cash-out is
      // engine-owned now (GameServerAPI.removeChips -> atomic_table_withdraw).
      // If this ever comes back, it should come back deliberately.
      expect((WalletService as unknown as Record<string, unknown>).unlockFromTable).toBeUndefined();
    });

    it('never calls a generic wallet-credit RPC from any method', async () => {
      // Both wrappers are revoked from `authenticated` in production, so a call
      // would fail anyway — but failing loudly at review time is better than
      // failing at runtime on a money path.
      const forbidden = ['atomic_credit_wallet_and_log', 'fn_idempotent_credit_wallet'];

      mockRpc.mockResolvedValue({ data: true, error: null });
      await WalletService.lockForBuyIn('user1', 'table-123', 500).catch(() => undefined);

      for (const [name] of mockRpc.mock.calls) {
        expect(forbidden).not.toContain(name);
      }
    });
  });
});

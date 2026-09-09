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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { WalletService } from '../../src/services/WalletService';

describe('WalletService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockReset();
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
      // The database returns both booked balances and the exact transfer scope.
      mockRpc.mockResolvedValueOnce({
        data: {
          success: true,
          from: 'BUSINESS',
          to: 'PLAYER',
          amount: 100,
          from_balance: 50,
          to_balance: 100,
        },
        error: null,
      });
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
      mockRpc.mockResolvedValueOnce({ data: { success: true }, error: null });
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

  it('does not submit an unkeyed transfer twice after a lost response', async () => {
    vi.useFakeTimers();
    mockRpc
      .mockRejectedValueOnce(new Error('network response lost after commit'))
      .mockResolvedValue({ data: { success: true }, error: null });
    const audit = vi.spyOn(WalletService, 'logTransaction').mockResolvedValue(undefined);
    try {
      const outcome = WalletService.transferToUser('sender', 'receiver', 5).then(
        () => 'accepted',
        () => 'unconfirmed'
      );
      await vi.runAllTimersAsync();
      expect(await outcome).toBe('unconfirmed');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(audit).not.toHaveBeenCalled();
      expect(mockBusEmit).not.toHaveBeenCalled();
    } finally {
      audit.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not append duplicate history after the database books both transfer legs', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        from: 'BUSINESS',
        to: 'PLAYER',
        amount: 5,
        from_balance: 95,
        to_balance: 5,
      },
      error: null,
    });
    const audit = vi.spyOn(WalletService, 'logTransaction').mockResolvedValue(undefined);
    try {
      await expect(
        WalletService.internalTransfer('sender', {
          fromWallet: 'BUSINESS',
          toWallet: 'PLAYER',
          amount: 5,
        })
      ).resolves.toBe(true);
      expect(audit).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
    } finally {
      audit.mockRestore();
    }
  });

  it.each(['missing', 'source', 'destination', 'amount', 'balance'])(
    'does not confirm an internal transfer with a mismatched %s receipt',
    async (kind) => {
      const data: Record<string, unknown> = {
        success: true,
        from: 'BUSINESS',
        to: 'PLAYER',
        amount: 5,
        from_balance: 95,
        to_balance: 5,
      };
      if (kind === 'missing') delete data.amount;
      if (kind === 'source') data.from = 'PROMO';
      if (kind === 'destination') data.to = 'PROMO';
      if (kind === 'amount') data.amount = 6;
      if (kind === 'balance') data.to_balance = NaN;
      mockRpc.mockResolvedValueOnce({ data, error: null });
      const audit = vi.spyOn(WalletService, 'logTransaction').mockResolvedValue(undefined);
      try {
        await expect(
          WalletService.internalTransfer('sender', {
            fromWallet: 'BUSINESS',
            toWallet: 'PLAYER',
            amount: 5,
          })
        ).rejects.toThrow(/confirmed/);
        expect(audit).not.toHaveBeenCalled();
        expect(mockBusEmit).not.toHaveBeenCalled();
      } finally {
        audit.mockRestore();
      }
    }
  );

  describe('transfer receipt boundaries', () => {
    const transfer = (kind: string, amount = 5) =>
      kind === 'internal'
        ? WalletService.internalTransfer('sender', {
            fromWallet: 'BUSINESS',
            toWallet: 'PLAYER',
            amount,
          })
        : WalletService.transferToUser('sender', 'receiver', amount);
    it.each(['internal', 'user'])('%s rejects nonfinite amounts before an RPC', async (kind) => {
      for (const amount of [NaN, Infinity, -Infinity]) {
        await expect(transfer(kind, amount)).rejects.toThrow(/positive/);
      }
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockBusEmit).not.toHaveBeenCalled();
    });
    it.each(['internal', 'user'])('%s requires literal successful confirmation', async (kind) => {
      const audit = vi.spyOn(WalletService, 'logTransaction').mockResolvedValue(undefined);
      try {
        for (const data of [null, {}, { success: 'false' }, { success: 1 }]) {
          mockRpc.mockResolvedValueOnce({ data, error: null });
          await expect(transfer(kind)).rejects.toThrow();
        }
        expect(audit).not.toHaveBeenCalled();
        expect(mockBusEmit).not.toHaveBeenCalled();
      } finally {
        audit.mockRestore();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROMO DISTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('disbursePromo', () => {
    // Dan, 2026-09-03: promo is disbursed by the union owner, or by an
    // unaffiliated club owner, and lands as ordinary chips. The old
    // agent-keyed distributePromo is retired and throws.
    it('rejects zero amounts', async () => {
      await expect(WalletService.disbursePromo('club1', 'player1', 0)).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('rejects negative amounts', async () => {
      await expect(WalletService.disbursePromo('club1', 'player1', -50)).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('refuses to report a server refusal as a paid disbursement', async () => {
      // the club lookup resolves the promo float's owner, then the RPC refuses
      mockFromChain.mockResolvedValueOnce({ data: { id: 'club1', union_id: null }, error: null });
      mockRpc.mockResolvedValueOnce({
        data: { success: false, error: 'Insufficient Promo Balance' },
        error: null,
      });

      await expect(WalletService.disbursePromo('club1', 'player1', 500)).rejects.toThrow(
        'Insufficient Promo Balance'
      );
    });

    it('is retired under its old agent-keyed name', async () => {
      await expect(WalletService.distributePromo('agent1', 'player1', 500)).rejects.toThrow(
        /retired/i
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BULK PROMO
  // ─────────────────────────────────────────────────────────────────────────

  describe('bulkDistributePromo', () => {
    it('should count successes and failures separately', async () => {
      // First two succeed, third fails
      // each disbursement resolves the club first, then calls the RPC
      mockFromChain.mockResolvedValue({ data: { id: 'club1', union_id: null }, error: null });
      mockRpc
        .mockResolvedValueOnce({ data: { success: true }, error: null })
        .mockResolvedValueOnce({ data: { success: true }, error: null })
        .mockResolvedValueOnce({ error: { message: 'failed' } });

      const result = await WalletService.bulkDistributePromo('club1', [
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

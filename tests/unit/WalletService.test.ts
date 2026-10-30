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

const mockGetSession = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    auth: { getSession: () => mockGetSession() },
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

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (id: string) => id,
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logWarning: vi.fn(),
    logCritical: vi.fn(),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { WalletService } from '../../src/services/WalletService';

const PROMO_OP_ID = '4f6d2c1e-8b3a-4c5d-9e7f-0a1b2c3d4e5f';

describe('WalletService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockReset();
  });

  describe('anonymous balance reads', () => {
    it.each(['guest', ''])('does not request a wallet or fabricate zero for %j', async (userId) => {
      mockRpc.mockResolvedValue({ data: { balance: 999 }, error: null });
      expect(await WalletService.readPlayerBalance(userId)).toEqual({
        balance: null,
        source: 'unauthenticated',
      });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('still reads an authenticated player through the existing scoped door', async () => {
      mockRpc.mockResolvedValueOnce({ data: { balance: 12.34 }, error: null });
      expect(
        await WalletService.readPlayerBalance('player', { clubId: 'club', tableId: 'table' })
      ).toEqual({
        balance: 12.34,
        source: 'rpc',
      });
      expect(mockRpc).toHaveBeenCalledWith('fn_player_spendable_balance', {
        p_user_id: 'player',
        p_club_id: 'club',
        p_table_id: 'table',
        p_tournament_id: null,
      });
    });
  });

  it('does not expose transfers into the retired global wallet pool', () => {
    expect(WalletService).not.toHaveProperty('internalTransfer');
    expect(WalletService).not.toHaveProperty('transferToUser');
    expect(typeof WalletService.agentSelfTransfer).toBe('function');
  });

  describe('disbursePromo', () => {
    // Dan, 2026-09-03: promo is disbursed by the union owner, or by an
    // unaffiliated club owner, and lands as ordinary chips. The old
    // agent-keyed distributePromo is retired and throws.
    it('rejects zero amounts', async () => {
      await expect(
        WalletService.disbursePromo('club1', 'player1', 0, undefined, PROMO_OP_ID)
      ).rejects.toThrow('Amount must be positive');
    });

    it('rejects negative amounts', async () => {
      await expect(
        WalletService.disbursePromo('club1', 'player1', -50, undefined, PROMO_OP_ID)
      ).rejects.toThrow('Amount must be positive');
    });

    it('refuses to report a server refusal as a paid disbursement', async () => {
      // the club lookup resolves the promo float's owner, then the RPC refuses
      mockFromChain.mockResolvedValueOnce({ data: { id: 'club1', union_id: null }, error: null });
      mockRpc.mockResolvedValueOnce({
        data: { success: false, error: 'Insufficient Promo Balance' },
        error: null,
      });

      await expect(
        WalletService.disbursePromo('club1', 'player1', 500, undefined, PROMO_OP_ID)
      ).rejects.toThrow('Insufficient Promo Balance');
    });

    it('refuses to pay without a caller-retained operation id (launch audit S-04)', async () => {
      for (const missing of [undefined, '', 'not-a-uuid']) {
        await expect(
          WalletService.disbursePromo('club1', 'player1', 500, undefined, missing as never)
        ).rejects.toThrow('Promo Disbursement Requires A Retained Operation Id');
      }
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('a retry after a refused rpc carries the same caller-retained p_op_id', async () => {
      mockFromChain.mockResolvedValue({ data: { id: 'club1', union_id: null }, error: null });
      mockRpc
        .mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } })
        .mockResolvedValueOnce({ data: { success: true }, error: null });
      const retained = PROMO_OP_ID;
      await expect(
        WalletService.disbursePromo('club1', 'player1', 500, undefined, retained)
      ).rejects.toThrow();
      await WalletService.disbursePromo('club1', 'player1', 500, undefined, retained);
      expect(mockRpc).toHaveBeenCalledTimes(2);
      expect(mockRpc.mock.calls[0][1].p_op_id).toBe(retained);
      expect(mockRpc.mock.calls[1][1].p_op_id).toBe(retained);
      expect(mockRpc.mock.calls[0][0]).toBe('fn_promo_disburse');
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
    it('is gone: the browser cannot execute atomic_deduct_wallet_and_log', () => {
      // Buy-ins are debited by the engine's seat path; this wrapper had no
      // caller and failed with 42501 for every player (removed 2026-10-19).
      expect((WalletService as unknown as Record<string, unknown>).lockForBuyIn).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MINT CHIPS: THE IDEMPOTENCY KEY BELONGS TO THE CALLER (launch audit S-03)
  // ─────────────────────────────────────────────────────────────────────────

  describe('mintChips', () => {
    const CLUB = '11111111-1111-4111-8111-111111111111';
    const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockReset();
      mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } });
      mockFromChain.mockResolvedValue({
        data: { id: CLUB, name: 'Shark Club', owner_id: 'owner-1', union_id: null },
        error: null,
      });
    });

    it('sends the caller-supplied key and the SAME key when the caller retries', async () => {
      // Attempt 1: the mint may have committed; the response never arrived.
      fetchMock.mockRejectedValueOnce(new Error('network lost'));
      await expect(WalletService.mintChips(CLUB, 100, KEY, 'owner-1')).rejects.toThrow(
        'network lost'
      );
      // Attempt 2: the caller presents the key it held across the failure.
      fetchMock.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, diamondsSpent: 100, newBalance: 0 }),
      });
      const result = await WalletService.mintChips(CLUB, 100, KEY, 'owner-1');
      expect(result.success).toBe(true);

      const keys = fetchMock.mock.calls.map(
        ([, init]) => (init as RequestInit).headers as Record<string, string>
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]['X-Idempotency-Key']).toBe(KEY);
      expect(keys[1]['X-Idempotency-Key']).toBe(KEY);
    });

    it('refuses to mint without a key rather than minting one for the caller', async () => {
      await expect(
        WalletService.mintChips(CLUB, 100, '' as unknown as string, 'owner-1')
      ).rejects.toThrow(/idempotency key/i);
      expect(fetchMock).not.toHaveBeenCalled();
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

      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/services/WalletService.ts', 'utf8');
      for (const name of forbidden) {
        expect(source).not.toContain(`'${name}'`);
      }
    });
  });
});

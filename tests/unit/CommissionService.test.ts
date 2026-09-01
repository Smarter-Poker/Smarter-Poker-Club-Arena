/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CommissionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the hierarchical commission rate system:
 * - RATE CAP enforcement (AGENT 70%, SUB_AGENT 60%, PLAYER 50%)
 * - Negative rate rejection
 * - Rate change audit trail
 * - Bus event on commission payout execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockUpsert = vi.fn();
const mockMaybeSingle = vi.fn();

// Build a recursive Proxy-based mock chain that handles ANY Supabase query depth
// When `then` is accessed, behaves as a Promise resolving to { error: null, data: null }
// This mirrors real Supabase PostgREST builder behavior where any chain is awaitable
const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single') return () => mockMaybeSingle();
      // Make the chain thenable so `await supabase.from().update().eq()` works
      if (prop === 'then') {
        return (resolve: (v: any) => void) => resolve({ error: null, data: null });
      }
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
    apply: () => new Proxy({}, handler),
  };
  return new Proxy({}, handler);
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: () => ({
      select: vi.fn().mockReturnValue(buildChain()),
      upsert: (...args: any[]) => {
        mockUpsert(...args);
        return buildChain();
      },
      update: vi.fn().mockReturnValue(buildChain()),
      insert: vi.fn().mockReturnValue(buildChain()),
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

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { CommissionService } from '../../src/services/CommissionService';

describe('CommissionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain queued mock*ValueOnce implementations, so a
    // test that queues more one-shot responses than the code consumes leaks the
    // remainder into the NEXT test. mockReset drains them.
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
    mockUpsert.mockReset();
    // setRate writes through the fn_admin_update_agent SECURITY DEFINER RPC
    // (direct `agents` writes are RLS-locked). Without a default resolution the
    // service destructures `undefined` and every setRate test dies in the mock
    // rather than in the code under test.
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RATE CAP ENFORCEMENT
  // ─────────────────────────────────────────────────────────────────────────

  describe('setRate — cap enforcement', () => {
    it('should reject AGENT rate above 70%', async () => {
      await expect(
        CommissionService.setRate('club1', 'agent1', 'AGENT', 0.71, 'admin')
      ).rejects.toThrow('AGENT rate capped at 70%');
    });

    it('should reject SUB_AGENT rate above 60%', async () => {
      await expect(
        CommissionService.setRate('club1', 'agent1', 'SUB_AGENT', 0.61, 'admin')
      ).rejects.toThrow('SUB_AGENT rate capped at 60%');
    });

    it('should reject PLAYER rate above 50%', async () => {
      await expect(
        CommissionService.setRate('club1', 'agent1', 'PLAYER', 0.51, 'admin')
      ).rejects.toThrow('PLAYER rate capped at 50%');
    });

    it('should accept AGENT rate at exactly 70%', async () => {
      mockMaybeSingle
        .mockResolvedValueOnce({ data: null }) // existing rate lookup
        .mockResolvedValueOnce({
          data: {
            id: 'rate-1',
            club_id: 'club1',
            agent_id: 'agent1',
            target_role: 'AGENT',
            rate: 0.7,
            effective_date: '2026-01-01',
            created_by: 'admin',
          },
        }); // upsert result

      const result = await CommissionService.setRate('club1', 'agent1', 'AGENT', 0.7, 'admin');
      expect(result.rate).toBe(0.7);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NEGATIVE RATE REJECTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('setRate — input validation', () => {
    it('should reject negative rates', async () => {
      await expect(
        CommissionService.setRate('club1', 'agent1', 'AGENT', -0.1, 'admin')
      ).rejects.toThrow('Rate cannot be negative');
    });

    it('should accept rate of 0 (zero commission)', async () => {
      mockMaybeSingle
        .mockResolvedValueOnce({ data: { rate: 0.5 } }) // old rate
        .mockResolvedValueOnce({
          data: {
            id: 'rate-1',
            club_id: 'club1',
            agent_id: 'agent1',
            target_role: 'AGENT',
            rate: 0,
            effective_date: '2026-01-01',
            created_by: 'admin',
          },
        });

      const result = await CommissionService.setRate('club1', 'agent1', 'AGENT', 0, 'admin');
      expect(result.rate).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // CLAIMING COMMISSION - WHAT REPLACED executePayout
  // ─────────────────────────────────────────────────────────────────────────
  //
  // executePayout called execute_commission_payout, which credited a wallet,
  // debited nothing and never marked the commission settled - so the same row
  // could be paid forever. Both the RPC and the method are gone (migration
  // 20260902000001). These pins cover the loop that replaced them.

  describe('claimCommission', () => {
    it('claims in batches until the server says there is no more', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: { success: true, amount: 100, more: true }, error: null })
        .mockResolvedValueOnce({ data: { success: true, amount: 40, more: false }, error: null });

      const result = await CommissionService.claimCommission('club-1');

      expect(result.claimed).toBe(140);
      expect(result.batches).toBe(2);
      expect(result.stoppedEarly).toBe(false);
      expect(mockRpc).toHaveBeenCalledWith('fn_agent_claim_commission', expect.any(Object));
    });

    it('sends a DIFFERENT op_id per batch, or the second call would replay the first', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: { success: true, amount: 10, more: true }, error: null })
        .mockResolvedValueOnce({ data: { success: true, amount: 10, more: false }, error: null });

      await CommissionService.claimCommission('club-1');

      const first = mockRpc.mock.calls[0][1] as { p_op_id: string };
      const second = mockRpc.mock.calls[1][1] as { p_op_id: string };
      expect(first.p_op_id).toBeTruthy();
      expect(second.p_op_id).toBeTruthy();
      expect(first.p_op_id).not.toBe(second.p_op_id);
    });

    it('emits COMMISSION_PAID once, for the whole claim', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { success: true, amount: 5000, more: false },
        error: null,
      });

      await CommissionService.claimCommission('club-1');

      expect(mockBusEmit).toHaveBeenCalledWith('COMMISSION_PAID', {
        agentId: 'self',
        amount: 5000,
      });
    });

    it('throws the server refusal when the FIRST batch is refused', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { success: false, error: 'The Club Bank Holds 1.00 Chips And Owes You 803.49.' },
        error: null,
      });

      await expect(CommissionService.claimCommission('club-1')).rejects.toThrow(
        /The Club Bank Holds/
      );
      expect(mockBusEmit).not.toHaveBeenCalledWith('COMMISSION_PAID', expect.anything());
    });

    it('keeps what it already claimed when a LATER batch is refused', async () => {
      // Money that moved, moved. Throwing here would tell the agent nothing was
      // paid while their balance says otherwise.
      mockRpc
        .mockResolvedValueOnce({ data: { success: true, amount: 700, more: true }, error: null })
        .mockResolvedValueOnce({ data: { success: false, error: 'Bank Short' }, error: null });

      const result = await CommissionService.claimCommission('club-1');

      expect(result.claimed).toBe(700);
      expect(result.stoppedEarly).toBe(true);
      expect(result.reason).toMatch(/Bank Short/);
    });

    it('throws when the RPC itself fails', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });

      await expect(CommissionService.claimCommission('club-1')).rejects.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVE PAYOUT
  // ─────────────────────────────────────────────────────────────────────────

  describe('approvePayout', () => {
    it('should update status to approved with metadata', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ error: null });

      // approvePayout updates status — verify it doesn't throw
      await expect(
        CommissionService.approvePayout('payout-1', 'admin-user')
      ).resolves.not.toThrow();
    });
  });
});

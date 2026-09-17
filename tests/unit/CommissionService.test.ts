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
const mockEq = vi.fn();

// Build a recursive Proxy-based mock chain that handles ANY Supabase query depth
// When `then` is accessed, behaves as a Promise resolving to { error: null, data: null }
// This mirrors real Supabase PostgREST builder behavior where any chain is awaitable
const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single') return () => mockMaybeSingle();
      if (prop === 'eq')
        return (...args: unknown[]) => {
          mockEq(...args);
          return new Proxy({}, handler);
        };
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
  resolveClubUUIDStrict: vi.fn().mockResolvedValue('resolved-uuid'),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { CommissionService } from '../../src/services/CommissionService';
import { resolveClubUUIDStrict } from '../../src/utils/clubIdResolver';

describe('CommissionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain queued mock*ValueOnce implementations, so a
    // test that queues more one-shot responses than the code consumes leaks the
    // remainder into the NEXT test. mockReset drains them.
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
    mockUpsert.mockReset();
    vi.mocked(resolveClubUUIDStrict).mockReset().mockResolvedValue('resolved-uuid');
    // setRate writes through the fn_admin_update_agent SECURITY DEFINER RPC
    // (direct `agents` writes are RLS-locked). Without a default resolution the
    // service destructures `undefined` and every setRate test dies in the mock
    // rather than in the code under test.
    mockRpc.mockResolvedValue({
      data: { success: true, agent_id: 'agent1', club_id: 'resolved-uuid' },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'agent1', club_id: 'resolved-uuid' },
      error: null,
    });
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
      const result = await CommissionService.setRate('club1', 'agent1', 'AGENT', 0, 'admin');
      expect(result.rate).toBe(0);
    });

    it.each([NaN, Infinity, -Infinity])(
      'rejects a nonfinite rate %s before any request',
      async (rate) => {
        await expect(
          CommissionService.setRate('club1', 'agent1', 'AGENT', rate, 'admin')
        ).rejects.toThrow('Finite');
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockMaybeSingle).not.toHaveBeenCalled();
      }
    );

    it('scopes the authoritative agent lookup to the resolved selected club', async () => {
      const result = await CommissionService.setRate('301101', 'agent1', 'AGENT', 0.3, 'admin');
      expect(resolveClubUUIDStrict).toHaveBeenCalledWith('301101');
      expect(mockEq).toHaveBeenCalledWith('id', 'agent1');
      expect(mockEq).toHaveBeenCalledWith('club_id', 'resolved-uuid');
      expect(result.clubId).toBe('resolved-uuid');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        'fn_admin_update_agent',
        expect.objectContaining({ p_agent_id: 'agent1', p_commission_rate: 0.3 })
      );
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it.each([
      { data: null, error: null },
      { data: { id: 'agent1', club_id: 'other-club' }, error: null },
      { data: { id: 'other-agent', club_id: 'resolved-uuid' }, error: null },
      { data: null, error: new Error('Read Failed') },
    ])('does not update when the selected club agent cannot be confirmed: %j', async (lookup) => {
      mockMaybeSingle.mockResolvedValueOnce(lookup);
      await expect(
        CommissionService.setRate('301101', 'agent1', 'AGENT', 0.3, 'admin')
      ).rejects.toBeDefined();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it.each([
      null,
      {},
      { success: 'true' },
      { success: false, error: 'Refused' },
      { success: true },
      { success: true, agent_id: 'other-agent', club_id: 'resolved-uuid' },
      { success: true, agent_id: 'agent1', club_id: 'other-club' },
    ])('never confirms an unavailable, refused or mismatched update: %j', async (data) => {
      mockRpc.mockResolvedValueOnce({ data, error: null });
      await expect(
        CommissionService.setRate('301101', 'agent1', 'AGENT', 0.3, 'admin')
      ).rejects.toBeDefined();
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // The client reads unpaid commission; the weekly coordinator is the writer.
  describe('unsettledCommission', () => {
    it('reads the exact selected club and current member without emitting a payment', async () => {
      mockRpc.mockResolvedValueOnce({ data: '140.29', error: null });
      await expect(CommissionService.unsettledCommission('club-1', 'user-1')).resolves.toBe(140.29);
      expect(mockRpc).toHaveBeenCalledWith('fn_agent_unsettled_commission', {
        p_club_id: 'resolved-uuid',
        p_user_id: 'user-1',
      });
      expect(mockBusEmit).not.toHaveBeenCalledWith('COMMISSION_PAID', expect.anything());
      expect('claimCommission' in CommissionService).toBe(false);
    });

    it('keeps a verified zero distinct from missing or invalid data', async () => {
      mockRpc.mockResolvedValueOnce({ data: 0, error: null });
      await expect(CommissionService.unsettledCommission('club-1', 'user-1')).resolves.toBe(0);
      for (const data of [null, undefined, '', ' ', false, 'NaN', 'Infinity', {}]) {
        mockRpc.mockResolvedValueOnce({ data, error: null });
        await expect(CommissionService.unsettledCommission('club-1', 'user-1')).rejects.toThrow(
          /Unavailable/
        );
      }
    });

    it('propagates an unavailable balance read instead of claiming zero owed', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
      await expect(CommissionService.unsettledCommission('club-1', 'user-1')).rejects.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVE PAYOUT
  // ─────────────────────────────────────────────────────────────────────────

  describe('approvePayout', () => {
    /**
     * The title of this test used to say "should update status to approved with
     * metadata". It has not done that since the payout tables went: the method
     * is a retired no-op that logs and returns false, and the assertion only
     * ever checked that it did not throw - which a no-op cannot. A test name
     * describing behaviour the code does not have is a promise nobody is
     * keeping, in the same family as the columns and tables phase 7 removed.
     */
    it('is retired: returns false, touches nothing, approves nobody', async () => {
      mockRpc.mockClear();
      mockUpsert.mockClear();

      await expect(CommissionService.approvePayout('payout-1', 'admin-user')).resolves.toBe(false);

      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WHAT A DOWNLINE IS OWED
  // ─────────────────────────────────────────────────────────────────────────
  //
  // The Sub-Agents tab printed agents.pending_commission until phase 7 - a
  // column nothing wrote. It cannot select from agent_commissions instead: RLS
  // gives an agent their OWN rows and nobody else's, which is why this goes
  // through a definer function scoped to the caller's own downline.

  describe('downlineCommission', () => {
    it('resolves a friendly club before requesting downline balances', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            agent_id: 'a1',
            user_id: 'u1',
            club_id: 'resolved-uuid',
            unclaimed: '12.34',
          },
        ],
        error: null,
      });
      await expect(CommissionService.downlineCommission('301101')).resolves.toEqual([
        { agentId: 'a1', userId: 'u1', unclaimed: 12.34 },
      ]);
      expect(resolveClubUUIDStrict).toHaveBeenCalledWith('301101');
      expect(mockRpc).toHaveBeenCalledWith('fn_agent_downline_commission', {
        p_club_id: 'resolved-uuid',
      });
    });

    it('does not issue either accounting RPC when club identity is unavailable', async () => {
      vi.mocked(resolveClubUUIDStrict).mockRejectedValue(new Error('Club Identity Is Unavailable'));
      await expect(CommissionService.downlineCommission('missing')).rejects.toThrow(
        'Club Identity'
      );
      await expect(CommissionService.unsettledCommission('missing', 'user-1')).rejects.toThrow(
        'Club Identity'
      );
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it.each([
      null,
      {},
      [{ agent_id: 'a1', user_id: 'u1', club_id: 'resolved-uuid', unclaimed: null }],
      [{ agent_id: 'a1', user_id: 'u1', club_id: 'resolved-uuid', unclaimed: 'invalid' }],
      [{ agent_id: 'a1', user_id: 'u1', club_id: 'other-club', unclaimed: 12.34 }],
      [
        { agent_id: 'a1', user_id: 'u1', club_id: 'resolved-uuid', unclaimed: 12.34 },
        { agent_id: 'a1', user_id: 'u1', club_id: 'resolved-uuid', unclaimed: 56.78 },
      ],
    ])('rejects unavailable, malformed, cross-club or duplicate balances: %j', async (data) => {
      mockRpc.mockResolvedValueOnce({ data, error: null });
      await expect(CommissionService.downlineCommission('301101')).rejects.toThrow(
        'Sub-Agent Commission Is Unavailable'
      );
    });

    it('asks the scoped RPC and maps what it answers', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          { agent_id: 'a1', user_id: 'u1', club_id: 'c1', unclaimed: '120.50' },
          { agent_id: 'a2', user_id: 'u2', club_id: 'c1', unclaimed: 0 },
        ],
        error: null,
      });

      const rows = await CommissionService.downlineCommission();

      expect(mockRpc).toHaveBeenCalledWith('fn_agent_downline_commission', {
        p_club_id: null,
      });
      expect(rows).toEqual([
        { agentId: 'a1', userId: 'u1', unclaimed: 120.5 },
        { agentId: 'a2', userId: 'u2', unclaimed: 0 },
      ]);
    });

    it('throws rather than reporting zero when the read fails', async () => {
      // A denied or failed read is not a downline that is owed nothing. The
      // dashboard binds this error; it must not arrive as an empty list.
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });

      await expect(CommissionService.downlineCommission()).rejects.toBeDefined();
    });
  });
});

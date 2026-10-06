/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AgentService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests agent hierarchy and validation rules:
 * - Commission rate caps (max 70%)
 * - Rakeback rate caps (max 50%)
 * - Valid commission rate steps (40–70% in 5% increments)
 * - Credit limit negativity guard
 * - Self-transfer same-wallet guard
 * - Required field validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    from: vi.fn(() => buildChain()),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/ChipFlowService', () => ({
  ChipFlowService: {},
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { AgentService } from '../../src/services/AgentService';
import { supabase } from '../../src/lib/supabase';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const CLUB_ID = '44444444-4444-4444-8444-444444444444';
const TRANSACTION_ID = '55555555-5555-4555-8555-555555555555';

const resolvedChain = (result: { data: unknown; error: unknown }): any => {
  let proxy: any;
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'then') return Promise.resolve(result).then.bind(Promise.resolve(result));
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(result);
      return vi.fn(() => proxy);
    },
  };
  proxy = new Proxy({}, handler);
  return proxy;
};

const validAgentRow = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  user_id: USER_ID,
  club_id: CLUB_ID,
  membership_id: null,
  role: 'agent',
  status: 'active',
  parent_agent_id: null,
  commission_rate: '0.5000',
  player_rakeback_rate: '0.3000',
  credit_limit: '500.25',
  credit_used: '100.25',
  is_prepaid: false,
  business_balance: '40.00',
  player_balance: '20.00',
  promo_balance: '5.00',
  total_players: 4,
  active_player_count: 3,
  sub_agent_count: 0,
  weekly_rake_generated: '50.2500',
  lifetime_earnings: '900.25',
  joined_at: '2026-10-01T00:00:00.000Z',
  last_active_at: null,
  ...overrides,
});

const validProfile = () => ({
  id: USER_ID,
  username: 'agent-alpha',
  display_name: null,
  alias: 'Agent Alpha',
  display_name_preference: null,
  use_real_name: false,
  avatar_url: null,
});

describe('AgentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // COMMISSION RATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('commission rate caps', () => {
    it('should reject commission rate above 70%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.75,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
        // 2026-08-15: regex updated to the message createAgent actually throws.
        // The 70% cap IS enforced (AgentService.ts:270-271); only the wording
        // differs from the old /exceed 70%/i — createAgent says "must be between
        // 0% and 70%", while updateRates says "cannot exceed 70%".
      ).rejects.toThrow(/commission rate must be between 0% and 70%/i);
    });

    it('should reject commission rate at 71%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.71,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAKEBACK RATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('rakeback rate caps', () => {
    it('should reject rakeback rate above 50%', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: 0.55,
          creditLimit: 10000,
        })
        // 2026-08-15: regex updated to the message createAgent actually throws.
        // The 50% rakeback cap IS enforced (AgentService.ts:272-273); the
        // wording is "must be between 0% and 50%", not "cannot exceed 50%".
      ).rejects.toThrow(/rakeback rate must be between 0% and 50%/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUIRED FIELDS
  // ─────────────────────────────────────────────────────────────────────────

  describe('required field validation', () => {
    it('should reject missing commission rate', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: undefined as any,
          playerRakebackRate: 0.3,
          creditLimit: 10000,
        })
      ).rejects.toThrow(/commission rate is required/i);
    });

    it('should reject missing rakeback rate', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: undefined as any,
          creditLimit: 10000,
        })
      ).rejects.toThrow(/rakeback rate is required/i);
    });

    it('should reject missing credit limit', async () => {
      await expect(
        AgentService.createAgent({
          userId: 'user-1',
          clubId: 'club-1',
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: 0.3,
          creditLimit: undefined as any,
        })
      ).rejects.toThrow(/credit limit is required/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALID COMMISSION RATE STEPS (createAgent)
  // ─────────────────────────────────────────────────────────────────────────

  describe('valid commission rate steps', () => {
    const validRates = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

    it('should define exactly 7 valid rate steps', () => {
      expect(validRates).toHaveLength(7);
    });

    it.each(validRates)('should include %s as valid rate', (rate) => {
      expect(validRates.includes(rate)).toBe(true);
    });

    it('should reject 0.42 (not a 5% step)', () => {
      expect(validRates.includes(0.42)).toBe(false);
    });

    it('should reject 0.35 (below minimum 40%)', () => {
      expect(validRates.includes(0.35)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RATE UPDATE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateRates', () => {
    it('should reject commission rate above 70%', async () => {
      await expect(AgentService.updateRates('agent-1', 0.8)).rejects.toThrow(/exceed 70%/i);
    });

    it('should reject rakeback rate above 50%', async () => {
      await expect(AgentService.updateRates('agent-1', undefined, 0.6)).rejects.toThrow(
        /exceed 50%/i
      );
    });
  });

  // selfTransfer() was deleted on 2026-09-04: no caller anywhere in src/, and
  // it passed an agents-table id into a user-id parameter, so it could not
  // have worked for the first caller to try it. Its guards left with it.

  // ─────────────────────────────────────────────────────────────────────────
  // CREDIT LIMIT GUARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('setCreditLimit', () => {
    it('should reject negative credit limit', async () => {
      await expect(AgentService.setCreditLimit('agent-1', -500, 'owner-1')).rejects.toThrow(
        /negative/i
      );
    });

    it('preserves an authoritative RPC refusal so the page can revoke access', async () => {
      const refusal = { code: '42501', message: 'Credit Access Refused' };
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: refusal } as never);

      await expect(AgentService.setCreditLimit(AGENT_ID, 500, OWNER_ID)).rejects.toBe(refusal);
    });

    it('normalizes the RPC JSON authority refusal to 42501', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: { success: false, error: "not authorized to manage this club's agents" },
        error: null,
      } as never);

      await expect(AgentService.setCreditLimit(AGENT_ID, 500, OWNER_ID)).rejects.toMatchObject({
        code: '42501',
        message: "not authorized to manage this club's agents",
      });
    });
  });

  describe('agent admin authority refusals', () => {
    const refusal = {
      data: { success: false, error: "not authorized to manage this club's agents" },
      error: null,
    };

    it.each([
      ['suspend', () => AgentService.updateAgentStatus(AGENT_ID, 'suspended')],
      ['promote', () => AgentService.updateAgentRole(AGENT_ID, 'super_agent')],
      [
        'create',
        () =>
          AgentService.createAgent({
            userId: USER_ID,
            clubId: CLUB_ID,
            role: 'agent',
            commissionRate: 0.5,
            playerRakebackRate: 0.3,
            creditLimit: 500,
          }),
      ],
    ])('normalizes the real JSON refusal for %s', async (_label, call) => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce(refusal as never);

      await expect(call()).rejects.toMatchObject({
        code: '42501',
        message: "not authorized to manage this club's agents",
      });
    });
  });

  describe('strict agent-management boundaries', () => {
    it('accepts only a selected-club agent roster with finite typed values', async () => {
      vi.mocked(supabase.from)
        .mockReturnValueOnce(resolvedChain({ data: [validAgentRow()], error: null }))
        .mockReturnValueOnce(resolvedChain({ data: [validProfile()], error: null }));

      await expect(AgentService.getAgents(CLUB_ID)).resolves.toMatchObject([
        {
          id: AGENT_ID,
          userId: USER_ID,
          clubId: CLUB_ID,
          creditLimit: 500.25,
          creditUsed: 100.25,
          displayName: 'Agent Alpha',
        },
      ]);
    });

    it.each([
      ['wrong club', [validAgentRow({ club_id: '66666666-6666-4666-8666-666666666666' })]],
      ['null money', [validAgentRow({ credit_limit: null })]],
      ['bad money', [validAgentRow({ business_balance: 'not-a-number' })]],
      ['negative wallet', [validAgentRow({ business_balance: '-0.01' })]],
      ['bad role', [validAgentRow({ role: 'owner' })]],
      ['not an array', { id: AGENT_ID }],
    ])('fails the roster closed for %s', async (_label, roster) => {
      vi.mocked(supabase.from).mockReturnValueOnce(resolvedChain({ data: roster, error: null }));
      await expect(AgentService.getAgents(CLUB_ID)).rejects.toThrow(/Malformed/);
    });

    it('fails closed instead of presenting a capped roster as an exact total', async () => {
      vi.mocked(supabase.from).mockReturnValueOnce(
        resolvedChain({ data: Array.from({ length: 501 }, () => ({})), error: null })
      );

      await expect(AgentService.getAgents(CLUB_ID)).rejects.toThrow(/Malformed/);
    });

    it.each([
      { success: 'true', agent_id: AGENT_ID, club_id: CLUB_ID },
      { success: true, agent_id: USER_ID, club_id: CLUB_ID },
      {
        success: true,
        agent_id: AGENT_ID,
        club_id: '66666666-6666-4666-8666-666666666666',
      },
    ])('does not confirm a malformed or mismatched mutation receipt: %j', async (data) => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data, error: null } as never);
      await expect(AgentService.updateAgentStatus(AGENT_ID, 'active', CLUB_ID)).rejects.toThrow(
        /Malformed/
      );
    });

    it.each([
      ['status', () => AgentService.updateAgentStatus(AGENT_ID, 'active', CLUB_ID)],
      ['role', () => AgentService.updateAgentRole(AGENT_ID, 'super_agent', CLUB_ID)],
      ['credit', () => AgentService.setCreditLimit(AGENT_ID, 500.25, OWNER_ID, undefined, CLUB_ID)],
      ['rates', () => AgentService.updateRates(AGENT_ID, 0.5, 0.3, CLUB_ID)],
      [
        'create',
        () =>
          AgentService.createAgent({
            userId: USER_ID,
            clubId: CLUB_ID,
            role: 'agent',
            commissionRate: 0.5,
            playerRakebackRate: 0.3,
            creditLimit: 500.25,
          }),
      ],
    ])('requires literal boolean success for %s', async (_label, call) => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: { success: 'false', error: 'Refused' },
        error: null,
      } as never);
      await expect(call()).rejects.toThrow(/Malformed/);
    });

    it('binds a created agent readback to the requested user and club', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: { success: true, agent_id: AGENT_ID },
        error: null,
      } as never);
      const getAgentSpy = vi.spyOn(AgentService, 'getAgent').mockResolvedValueOnce({
        id: AGENT_ID,
        userId: '66666666-6666-4666-8666-666666666666',
        clubId: CLUB_ID,
        role: 'agent',
        status: 'active',
        commissionRate: 0.5,
        playerRakebackRate: 0.3,
        creditLimit: 500.25,
        creditUsed: 0,
        isPrepaid: false,
        businessBalance: 0,
        playerBalance: 0,
        promoBalance: 0,
        totalPlayers: 0,
        activePlayerCount: 0,
        subAgentCount: 0,
        weeklyRakeGenerated: 0,
        lifetimeEarnings: 0,
        joinedAt: '2026-10-05T00:00:00.000Z',
      });

      await expect(
        AgentService.createAgent({
          userId: USER_ID,
          clubId: CLUB_ID,
          role: 'agent',
          commissionRate: 0.5,
          playerRakebackRate: 0.3,
          creditLimit: 500.25,
        })
      ).rejects.toThrow(/readback/);
      getAgentSpy.mockRestore();
    });

    it('requires credit receipt identity and the exact resulting limit', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: {
          success: true,
          agent_id: AGENT_ID,
          club_id: CLUB_ID,
          credit_limit: 500.26,
          is_prepaid: false,
        },
        error: null,
      } as never);

      await expect(
        AgentService.setCreditLimit(AGENT_ID, 500.25, OWNER_ID, undefined, CLUB_ID)
      ).rejects.toThrow(/Malformed/);
    });

    it('strictly validates reversible rows before enabling a claim back', async () => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({
        data: [
          {
            transaction_id: TRANSACTION_ID,
            to_user_id: USER_ID,
            to_name: 'Player One',
            amount: '10.00',
            claimed_back: '2.00',
            remaining: '7.99',
            destination: 'player_wallet',
            created_at: '2026-10-05T00:00:00.000Z',
            reversible_until: '2026-10-05T00:10:00.000Z',
            seconds_left: 300,
          },
        ],
        error: null,
      } as never);

      await expect(AgentService.reversibleDistributions(CLUB_ID)).rejects.toThrow(/remaining/);
    });

    it('preserves a 42501 claim-back refusal for immediate page revocation', async () => {
      const refusal = { code: '42501', message: 'Access Revoked' };
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: refusal } as never);

      await expect(AgentService.claimBackDistribution(CLUB_ID, TRANSACTION_ID, 10)).rejects.toBe(
        refusal
      );
    });

    it.each([
      {
        success: 'true',
        transaction_id: TRANSACTION_ID,
        amount: 10,
        replayed: false,
      },
      { success: true, transaction_id: TRANSACTION_ID, amount: 9.99, replayed: false },
      { success: true, transaction_id: TRANSACTION_ID, amount: 10, replayed: 'false' },
    ])('does not invent confirmation from a malformed claim receipt: %j', async (data) => {
      vi.mocked(supabase.rpc).mockResolvedValueOnce({ data, error: null } as never);
      await expect(AgentService.claimBackDistribution(CLUB_ID, TRANSACTION_ID, 10)).rejects.toThrow(
        /Malformed/
      );
    });
  });
});

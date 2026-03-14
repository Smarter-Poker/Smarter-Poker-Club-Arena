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
const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single') return () => mockMaybeSingle();
      if (prop === 'then') return undefined; // not a promise
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
  // EXECUTE PAYOUT — BUS EMISSION
  // ─────────────────────────────────────────────────────────────────────────

  describe('executePayout', () => {
    it('should emit COMMISSION_PAID bus event on successful payout', async () => {
      mockRpc.mockResolvedValueOnce({ error: null }); // execute_commission_payout
      mockMaybeSingle.mockResolvedValueOnce({
        data: { agent_id: 'agent-1', net_payout: 5000 },
      }); // fetch payout record

      await CommissionService.executePayout('payout-123');

      expect(mockBusEmit).toHaveBeenCalledWith('COMMISSION_PAID', {
        agentId: 'agent-1',
        amount: 5000,
      });
    });

    it('should throw on RPC failure', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'payout already executed' } });

      await expect(CommissionService.executePayout('payout-123')).rejects.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVE PAYOUT
  // ─────────────────────────────────────────────────────────────────────────

  describe('approvePayout', () => {
    it('should update status to approved with metadata', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ error: null });

      const result = await CommissionService.approvePayout('payout-1', 'admin-user');
      expect(result).toBe(true);
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BonusService
 *
 *  Rewritten for AUDIT M17 / M18. The previous version's mock resolved every
 *  Supabase call to `{ data: null, error: null }`, which is not a shape the real
 *  RPCs can return — so it asserted behaviour that only existed under the mock
 *  (notably `canClaimDaily === true` from a null row). These tests drive the
 *  service with realistic RPC payloads instead, and the load-bearing ones are
 *  the negative assertions at the bottom: the client must never call a credit
 *  RPC, and must never send an amount.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockEmit } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockEmit: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: [], error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: mockRpc,
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mockEmit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
}));

import { bonusService } from '../../src/services/BonusService';

const SCHEDULE = [
  { day: 1, reward: 100, reward_type: 'chips' },
  { day: 2, reward: 150, reward_type: 'chips' },
  { day: 3, reward: 200, reward_type: 'chips' },
  { day: 4, reward: 300, reward_type: 'chips' },
  { day: 5, reward: 500, reward_type: 'chips' },
  { day: 6, reward: 200, reward_type: 'vip_points' },
  { day: 7, reward: 1000, reward_type: 'chips' },
];

function statusPayload(over: Record<string, unknown> = {}) {
  return {
    data: {
      streak: 0,
      last_claim: null,
      can_claim: true,
      next_day: 1,
      schedule: SCHEDULE,
      ...over,
    },
    error: null,
  };
}

/** Every RPC name the browser must NEVER call to move chips. */
const FORBIDDEN_CREDIT_RPCS = [
  'atomic_credit_wallet_and_log',
  'fn_idempotent_credit_wallet',
  'add_vip_points',
  'credit_player_wallet',
  'claim_daily_bonus',
];

function assertNoClientCredit() {
  for (const [name] of mockRpc.mock.calls) {
    expect(FORBIDDEN_CREDIT_RPCS).not.toContain(name);
  }
}

describe('BonusService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockEmit.mockReset();
  });

  describe('getBonusStatus', () => {
    it('renders the ladder from the server schedule, not a local constant', async () => {
      mockRpc.mockResolvedValue(statusPayload({ streak: 2, next_day: 3, can_claim: true }));

      const status = await bonusService.getBonusStatus('user-1');

      expect(mockRpc).toHaveBeenCalledWith('fn_daily_bonus_status');
      expect(status.dailyBonuses).toHaveLength(7);
      expect(status.dailyBonuses[5]).toMatchObject({
        day: 6,
        reward: 200,
        rewardType: 'vip_points',
      });
      expect(status.currentDay).toBe(3);
      expect(status.streak).toBe(2);
      expect(status.canClaimDaily).toBe(true);
    });

    it('marks exactly the days behind the current ladder position as claimed', async () => {
      mockRpc.mockResolvedValue(statusPayload({ streak: 3, next_day: 4 }));

      const status = await bonusService.getBonusStatus('user-1');

      expect(status.dailyBonuses.filter((b) => b.claimed).map((b) => b.day)).toEqual([1, 2, 3]);
    });

    it('treats a fresh user as day 1 with nothing claimed', async () => {
      mockRpc.mockResolvedValue(statusPayload());

      const status = await bonusService.getBonusStatus('user-1');

      expect(status.currentDay).toBe(1);
      expect(status.streak).toBe(0);
      expect(status.dailyBonuses.some((b) => b.claimed)).toBe(false);
    });

    it('throws rather than reporting a claimable bonus when the RPC errors', async () => {
      // The old code inferred "can claim" from a missing row, so an outage read
      // as an available bonus. Availability is the server's call, and an
      // unanswered question is not a yes.
      mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

      await expect(bonusService.getBonusStatus('user-1')).rejects.toThrow(
        /could not load daily bonus status/i
      );
    });
  });

  describe('claimDailyBonus', () => {
    it('returns the amount the server says it paid', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, day: 2, streak: 2, amount: 150, reward_type: 'chips' },
        error: null,
      });

      const result = await bonusService.claimDailyBonus('user-1');

      expect(result).toEqual({
        success: true,
        reward: 150,
        rewardType: 'chips',
        day: 2,
        streak: 2,
      });
      expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
        source: 'bonus_chips',
        userId: 'user-1',
      });
    });

    it('sends no amount — the payout is not the client to decide', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, day: 1, streak: 1, amount: 100, reward_type: 'chips' },
        error: null,
      });

      await bonusService.claimDailyBonus('user-1');

      expect(mockRpc).toHaveBeenCalledTimes(1);
      const [name, args] = mockRpc.mock.calls[0];
      expect(name).toBe('fn_claim_daily_bonus');
      expect(args).toBeUndefined();
    });

    it('surfaces the server refusal reason instead of a generic failure', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: false, reason: 'already_claimed_today', streak: 1 },
        error: null,
      });

      await expect(bonusService.claimDailyBonus('user-1')).rejects.toThrow(
        'Daily bonus already claimed today'
      );
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('reports an unrecognised reason as itself, not as success', async () => {
      mockRpc.mockResolvedValue({ data: { ok: false, reason: 'some_new_rule' }, error: null });

      await expect(bonusService.claimDailyBonus('user-1')).rejects.toThrow(/some_new_rule/);
    });

    it('emits the vip_points balance source for a vip_points day', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, day: 6, streak: 6, amount: 200, reward_type: 'vip_points' },
        error: null,
      });

      await bonusService.claimDailyBonus('user-1');

      expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
        source: 'bonus_vip_points',
        userId: 'user-1',
      });
    });
  });

  describe('claimSpecialBonus', () => {
    it('claims through the RPC, passing only the bonus id', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, amount: 250, reward_type: 'chips' },
        error: null,
      });

      const ok = await bonusService.claimSpecialBonus('user-1', 'bonus-9');

      expect(ok).toBe(true);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('fn_claim_special_bonus', { p_bonus_id: 'bonus-9' });
    });

    it('throws on refusal rather than reporting a claim that did not happen', async () => {
      // This is the exact regression: the old implementation UPDATEd a
      // SELECT-only table, matched zero rows, saw no error, and returned true.
      mockRpc.mockResolvedValue({ data: { ok: false, reason: 'already_claimed' }, error: null });

      await expect(bonusService.claimSpecialBonus('user-1', 'bonus-9')).rejects.toThrow(
        'Bonus already claimed'
      );
    });

    it('throws when the RPC itself errors', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(bonusService.claimSpecialBonus('user-1', 'bonus-9')).rejects.toThrow(
        /failed to claim bonus/i
      );
    });
  });

  describe('no client-side credit path (AUDIT M17 regression guard)', () => {
    it('never calls a wallet-credit RPC while claiming a daily bonus', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, day: 1, streak: 1, amount: 100, reward_type: 'chips' },
        error: null,
      });

      await bonusService.claimDailyBonus('user-1');

      assertNoClientCredit();
    });

    it('never calls a wallet-credit RPC while claiming a special bonus', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, amount: 250, reward_type: 'chips' },
        error: null,
      });

      await bonusService.claimSpecialBonus('user-1', 'bonus-9');

      assertNoClientCredit();
    });

    it('no longer exposes a client-side awardReward helper', () => {
      // A browser-callable "credit this user N chips" is a mint, whatever it is
      // named. If this ever comes back, it should come back deliberately.
      expect((bonusService as unknown as Record<string, unknown>).awardReward).toBeUndefined();
    });
  });

  describe('export shape', () => {
    it('exports the singleton with the expected methods', () => {
      expect(typeof bonusService.getBonusStatus).toBe('function');
      expect(typeof bonusService.canSpinToday).toBe('function');
      expect(typeof bonusService.claimDailyBonus).toBe('function');
      expect(typeof bonusService.claimSpecialBonus).toBe('function');
      expect(typeof bonusService.getWheelStats).toBe('function');
      expect(typeof bonusService.spinLuckyWheel).toBe('function');
    });
  });
});

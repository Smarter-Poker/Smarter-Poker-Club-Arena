/**
 * DailyBonusService - the sheet's only door to the ledger.
 *
 * Pins the contract with fn_ca_daily_bonus_status / fn_ca_daily_bonus_claim:
 * no amount is ever sent, a retry of the same (day, slot) reuses its request
 * id so the server replays instead of paying twice, a refusal is returned
 * rather than thrown, and no wallet-credit RPC is ever named by this module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import {
  claimReasonText,
  dailyBonusService,
  diamondsToCentsLabel,
} from '../../src/services/DailyBonusService';

const STATUS = {
  eligible: true,
  today: '2026-09-08',
  reset_at: '2026-09-09T05:00:00+00:00',
  seconds_to_reset: 3600,
  streak: 3,
  cycle_day: 3,
  streak_day: null,
  multiplier: 1.2,
  is_vip: false,
  claimed_today: false,
  shown_today: false,
  unclaimed: 3,
  tiles: [
    {
      slot: 1,
      kind: 'diamonds',
      label: 'Diamonds',
      vip_only: false,
      quantity: 0,
      base_diamonds: 10,
      diamonds: 12,
      claimed: false,
      claimed_at: null,
      granted: null,
      locked: false,
      capped: false,
    },
  ],
  week: [],
  tomorrow: [],
  caps: { daily_cap: 110, daily_used: 0, daily_remaining: 110 },
  cents_per_diamond: 1,
};

describe('DailyBonusService', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.emit.mockReset();
    sessionStorage.clear();
  });

  it('reads the sheet from fn_ca_daily_bonus_status with no arguments', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: STATUS, error: null });
    const status = await dailyBonusService.getStatus();
    expect(mocks.rpc).toHaveBeenCalledWith('fn_ca_daily_bonus_status');
    expect(status.tiles[0].diamonds).toBe(12);
    expect(status.streak).toBe(3);
  });

  it('throws a player-facing error when the status RPC fails', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(dailyBonusService.getStatus()).rejects.toThrow('Could Not Load Your Daily Bonus');
  });

  it('claims by slot, request id and the day the sheet showed; the amount is never sent', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        slot: 1,
        granted: { kind: 'diamonds', diamonds: 12, quantity: 0, balance_after: 512 },
        streak: 3,
      },
      error: null,
    });
    const result = await dailyBonusService.claim('2026-09-08', 1);
    expect(result.success).toBe(true);
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe('fn_ca_daily_bonus_claim');
    expect(Object.keys(args).sort()).toEqual(['p_bonus_date', 'p_request_id', 'p_slot']);
    expect(args.p_slot).toBe(1);
    expect(args.p_bonus_date).toBe('2026-09-08');
    expect(args.p_request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses one request id per (day, slot) so a retry replays instead of paying twice', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, reason: 'already_claimed' },
      error: null,
    });
    await dailyBonusService.claim('2026-09-08', 2);
    await dailyBonusService.claim('2026-09-08', 2);
    await dailyBonusService.claim('2026-09-08', 3);
    const ids = mocks.rpc.mock.calls.map(([, args]) => args.p_request_id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(sessionStorage.getItem('ca_daily_bonus_req:2026-09-08:2')).toBe(ids[0]);
  });

  it('returns a refusal as an outcome rather than throwing', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { success: false, reason: 'vip_only' }, error: null });
    const result = await dailyBonusService.claim('2026-09-08', 5);
    expect(result).toEqual({ success: false, reason: 'vip_only' });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('tells the header to re-read balances after a grant, without an amount of its own', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        granted: { kind: 'throwables', diamonds: 0, quantity: 3, balance_after: 500 },
        streak: 1,
      },
      error: null,
    });
    await dailyBonusService.claim('2026-09-08', 2);
    expect(mocks.emit).toHaveBeenCalledWith(
      'BALANCE_UPDATED',
      expect.objectContaining({ source: 'daily_bonus_credit' })
    );
  });

  it('paints the ledger’s balance on the header the moment diamonds are granted', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        granted: { kind: 'diamonds', diamonds: 12, quantity: 0, balance_after: 512 },
        streak: 3,
      },
      error: null,
    });
    await dailyBonusService.claim('2026-09-08', 1);
    expect(mocks.emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
      newBalance: 512,
      delta: 12,
      source: 'daily_bonus',
    });
  });

  it('a claim that lands after midnight is a refusal the sheet can read, not a payment', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { success: false, reason: 'day_rolled_over', today: '2026-09-09' },
      error: null,
    });
    const result = await dailyBonusService.claim('2026-09-08', 1);
    expect(result.success).toBe(false);
    expect(claimReasonText(result.reason)).toBe('A New Day Has Started, Here Is Today’s Sheet');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('normalises a status payload so the sheet never counts or ticks from a missing field', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        eligible: false,
        reason: 'fixture',
        today: '2026-09-08',
        reset_at: '2026-09-09T05:00:00+00:00',
      },
      error: null,
    });
    const status = await dailyBonusService.getStatus();
    expect(status.unclaimed).toBe(0);
    expect(status.seconds_to_reset).toBe(0);
    expect(status.shown_today).toBe(false);
    expect(status.tiles).toEqual([]);
    // Phase 3 fields read as nothing held, nothing running, nothing protected
    // when the payload predates them.
    expect(status.shield).toEqual({ held: 0, expires_at: null });
    expect(status.boost).toEqual({ active: false });
    expect(status.streak_protected).toBe(false);
  });

  it('carries the shield, the live boost and a protected day through, as the ledger reports them', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ...STATUS,
        shield: { held: 2, expires_at: '2026-10-10T18:00:00+00:00' },
        boost: {
          active: true,
          factor: 2,
          kind: 'mission_diamonds',
          ends_at: '2026-09-09T18:00:00+00:00',
          seconds_left: 4000,
          applied_diamonds: 30,
        },
        streak_protected: true,
      },
      error: null,
    });
    const status = await dailyBonusService.getStatus();
    expect(status.shield).toEqual({ held: 2, expires_at: '2026-10-10T18:00:00+00:00' });
    expect(status.boost.active).toBe(true);
    expect(status.boost.seconds_left).toBe(4000);
    expect(status.boost.applied_diamonds).toBe(30);
    expect(status.streak_protected).toBe(true);
    // A boost the ledger says is not active never becomes one here.
    mocks.rpc.mockResolvedValueOnce({
      data: { ...STATUS, boost: { active: 'yes', seconds_left: 99 } },
      error: null,
    });
    expect((await dailyBonusService.getStatus()).boost).toEqual({ active: false });
  });

  it('marks today shown through its own RPC and swallows a failure (the local mark covers it)', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    await dailyBonusService.markShown();
    expect(mocks.rpc).toHaveBeenCalledWith('fn_ca_daily_bonus_mark_shown');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(dailyBonusService.markShown()).resolves.toBeUndefined();
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it('maps every server reason to Title Case copy and reads an unknown one as itself', () => {
    expect(claimReasonText('vip_only')).toBe('VIP Members Only');
    expect(claimReasonText('daily_cap')).toBe('Daily Diamond Cap Reached');
    expect(claimReasonText('boost_already_live')).toBe('A Mission Boost Is Already Running');
    expect(claimReasonText('something_new')).toBe('Could Not Claim (something_new)');
  });

  it('prices diamonds at one cent each', () => {
    expect(diamondsToCentsLabel(5)).toBe('5¢');
    expect(diamondsToCentsLabel(125)).toBe('$1.25');
  });
});

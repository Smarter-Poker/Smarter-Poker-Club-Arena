/**
 * The free spin (2026-09-09) is the paid wheel's machinery pointed at a
 * five-prize table that pays diamonds only. Three things the browser owes it:
 *
 *   1. the verifier walks the FREE table for a free spin, and the same
 *      Postgres-produced vector the paid test pins (seed, HMAC, roll) lands on
 *      ord 1 over the free weights: production Postgres computed point 397 of
 *      1,000 for roll 111921121211850 on 2026-09-09, and 397 < 700;
 *   2. the service reads fn_wheel_free_state and fn_wheel_free_spin as they
 *      are shaped, with numerics that PostgREST hands back as strings;
 *   3. paid and free spins print in one history, newest first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import DiamondWheelService, { mergeSpinHistory } from '../../src/services/DiamondWheelService';
import { pickOrd, pointFromRoll, verifyWheelSpin } from '../../src/utils/wheelFairness';

const SEED = 'a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_HASH = '6562095d0b88a7960aca86fc2b3be51f9f9193b15d206b1ccc5e1d230d21a391';
const ROLL = 111921121211850;

/** wheel_free_segments as seeded: 5 / 10 / 25 / 50 / 250 diamonds, weights out of 1,000. */
const FREE = [
  { ord: 1, weight: 700 },
  { ord: 2, weight: 200 },
  { ord: 3, weight: 70 },
  { ord: 4, weight: 25 },
  { ord: 5, weight: 5 },
];

describe('a free spin verifies over the free table', () => {
  it('maps the Postgres roll onto the free weights: point 397 of 1,000, ord 1', () => {
    expect(FREE.reduce((t, s) => t + s.weight, 0)).toBe(1000);
    expect(pointFromRoll(ROLL, 1000)).toBe(397);
    expect(pickOrd(397, FREE)).toBe(1);
  });

  it('passes the whole check, and fails it when the paid table is used by mistake', async () => {
    const input = {
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      weightTotal: 1000,
      eligible: FREE,
      outcomeOrd: 1,
    };
    expect((await verifyWheelSpin(input)).fair).toBe(true);
    // The paid table's weights sum to 100,000: the same roll lands on ord 2 there.
    const paid = [
      { ord: 1, weight: 23470 },
      { ord: 2, weight: 24000 },
      { ord: 3, weight: 52530 },
    ];
    const wrong = await verifyWheelSpin({ ...input, weightTotal: 100000, eligible: paid });
    expect(wrong.outcomeMatches).toBe(false);
    expect(wrong.fair).toBe(false);
  });
});

describe('the service reads the free spin as the server shapes it', () => {
  beforeEach(() => rpc.mockReset());

  it('normalises fn_wheel_free_state, strings and all', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        enabled: true,
        available: false,
        reason: 'used',
        used_today: true,
        pot_diamonds: '2000',
        pot_paid_today: '35',
        spins_today: '4',
        day: '2026-09-09',
        segments: [
          {
            ord: 1,
            label: '5 Diamonds',
            kind: 'diamonds',
            amount: 5,
            weight: 700,
            value_chips: '0.0500',
            probability: '0.700000',
            locked: false,
          },
        ],
      },
      error: null,
    });
    const s = await DiamondWheelService.freeState('club-1');
    expect(rpc).toHaveBeenCalledWith('fn_wheel_free_state', { p_club_id: 'club-1' });
    expect(s).toMatchObject({
      ok: true,
      enabled: true,
      available: false,
      reason: 'used',
      used_today: true,
      pot_diamonds: 2000,
      pot_paid_today: 35,
      spins_today: 4,
      day: '2026-09-09',
    });
    expect(s.segments[0]).toMatchObject({
      ord: 1,
      kind: 'diamonds',
      amount: 5,
      weight: 700,
      value_chips: 0.05,
      probability: 0.7,
      locked: false,
    });
  });

  it('treats a reason it does not know as no reason', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, available: true, reason: 'someday', segments: [] },
      error: null,
    });
    expect((await DiamondWheelService.freeState('club-1')).reason).toBeNull();
  });

  it('posts a free spin to fn_wheel_free_spin and reads it back as free', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        free: true,
        replayed: false,
        spin_id: 's1',
        spin_price_diamonds: 0,
        outcome: {
          ord: 2,
          kind: 'diamonds',
          amount: 10,
          label: '10 Diamonds',
          value_chips: '0.1000',
        },
        fairness: {
          commit_id: 'c1',
          server_seed_hash: 'h',
          server_seed: 's',
          client_seed: 'me',
          nonce: '1',
          roll: '246773286745074',
          weight_total: 1000,
          eligible_ords: [1, 2, 3, 4, 5],
          locked: [],
        },
        balances: { diamonds: '12283', member_chips: null },
        created_at: '2026-09-09T23:50:00Z',
      },
      error: null,
    });
    const r = await DiamondWheelService.freeSpin('club-1', 'c1', 'me');
    expect(rpc).toHaveBeenCalledWith('fn_wheel_free_spin', {
      p_club_id: 'club-1',
      p_commit_id: 'c1',
      p_client_seed: 'me',
    });
    expect(r.free).toBe(true);
    expect(r.spin_price_diamonds).toBe(0);
    expect(r.outcome).toEqual({
      ord: 2,
      kind: 'diamonds',
      amount: 10,
      label: '10 Diamonds',
      value_chips: 0.1,
    });
    expect(r.fairness.eligible_ords).toEqual([1, 2, 3, 4, 5]);
    expect(r.balances).toEqual({ diamonds: 12283, member_chips: null });
  });

  it('a paid spin is not free', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, spin_id: 'p1', outcome: {}, fairness: {}, balances: {}, pool: {} },
      error: null,
    });
    expect((await DiamondWheelService.spin('club-1', 'c2', 'me')).free).toBe(false);
  });

  it('carries the operator switch and pot to fn_wheel_set_free_spin', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'Only The Host’s Owners And Admins Run The Wheel' },
      error: null,
    });
    const r = await DiamondWheelService.setFreeSpin('club-1', {
      free_spin_enabled: false,
      free_spin_daily_budget_diamonds: 500,
    });
    expect(rpc).toHaveBeenCalledWith('fn_wheel_set_free_spin', {
      p_club_id: 'club-1',
      p_patch: { free_spin_enabled: false, free_spin_daily_budget_diamonds: 500 },
    });
    expect(r).toEqual({ ok: false, error: 'Only The Host’s Owners And Admins Run The Wheel' });
  });
});

describe('one history', () => {
  const at = (iso: string, free: boolean, id: string) =>
    ({ spin_id: id, free, created_at: iso }) as unknown as Parameters<
      typeof mergeSpinHistory
    >[0][number];

  it('prints paid and free spins together, newest first', () => {
    const merged = mergeSpinHistory(
      [at('2026-09-09T10:00:00Z', false, 'p-old'), at('2026-09-09T12:00:00Z', false, 'p-new')],
      [at('2026-09-09T11:00:00Z', true, 'f-mid')]
    );
    expect(merged.map((s) => s.spin_id)).toEqual(['p-new', 'f-mid', 'p-old']);
  });
});

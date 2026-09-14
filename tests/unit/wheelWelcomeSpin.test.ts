/**
 * THE WELCOME SPIN, FROM THE BROWSER'S SIDE (2026-09-11).
 *
 * This file used to be about the daily free spin, which drew a separate
 * five-prize diamonds-only table. That feature is retired: the welcome spin is
 * the REAL wheel, once per member per host ever, paid out of the promo wallet
 * against a budget the host declares over a sliding window. Two things the
 * browser owes it:
 *
 *   1. the verifier maps a Postgres-produced roll onto whatever weight set the
 *      spin was drawn from. The vector below is a real production computation
 *      (roll 111921121211850 -> point 397 of 1,000, which lands on ord 1) and
 *      is kept because it is a genuine Postgres cross-check of the arithmetic,
 *      not because the table it came from still exists;
 *   2. the service reads fn_wheel_welcome_state and fn_wheel_welcome_spin as
 *      they are shaped, including the window figures, with the numerics that
 *      PostgREST hands back as strings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import DiamondWheelService from '../../src/services/DiamondWheelService';
import { pickOrd, pointFromRoll, verifyWheelSpin } from '../../src/utils/wheelFairness';

const SEED = 'a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_HASH = '6562095d0b88a7960aca86fc2b3be51f9f9193b15d206b1ccc5e1d230d21a391';
const ROLL = 111921121211850;

/** A weight set out of 1,000, the shape the production vector below was drawn over. */
const WEIGHTS = [
  { ord: 1, weight: 700 },
  { ord: 2, weight: 200 },
  { ord: 3, weight: 70 },
  { ord: 4, weight: 25 },
  { ord: 5, weight: 5 },
];

describe('a spin verifies over the weights it was drawn from', () => {
  it('maps the Postgres roll onto those weights: point 397 of 1,000, ord 1', () => {
    expect(WEIGHTS.reduce((t, s) => t + s.weight, 0)).toBe(1000);
    expect(pointFromRoll(ROLL, 1000)).toBe(397);
    expect(pickOrd(397, WEIGHTS)).toBe(1);
  });

  it('passes the whole check, and fails it when the paid table is used by mistake', async () => {
    const input = {
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      weightTotal: 1000,
      eligible: WEIGHTS,
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

describe('the service reads the welcome spin as the server shapes it', () => {
  beforeEach(() => rpc.mockReset());

  it('normalises fn_wheel_welcome_state, window figures and all', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        enabled: true,
        available: false,
        reason: 'used',
        used: true,
        once_only: true,
        spin_price_diamonds: '100',
        budget_chips: '50',
        budget_period_days: '30',
        budget_paid_chips: '12.5',
        budget_left_chips: '37.5',
        top_prize_chips: '2.5',
        lifetime_chips_paid: '128.25',
        welcome_spins: '4',
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
    const s = await DiamondWheelService.welcomeState('club-1');
    expect(rpc).toHaveBeenCalledWith('fn_wheel_welcome_state', { p_club_id: 'club-1' });
    // THE WELCOME SPIN (Dan 2026-09-10): once per member per host, ever, at the
    // real spin price, against a budget in chips rather than a daily pot in
    // diamonds. The state says so rather than leaving the page to assume it.
    expect(s).toMatchObject({
      ok: true,
      enabled: true,
      available: false,
      reason: 'used',
      used: true,
      once_only: true,
      spin_price_diamonds: 100,
      budget_chips: 50,
      // The budget is a WINDOW now, not a lifetime cap: budget_period_days is
      // that window and budget_paid_chips is what has been spent inside it.
      // lifetime_chips_paid is the all-time figure, kept separate on purpose.
      budget_period_days: 30,
      budget_paid_chips: 12.5,
      budget_left_chips: 37.5,
      top_prize_chips: 2.5,
      lifetime_chips_paid: 128.25,
      welcome_spins: 4,
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
    expect((await DiamondWheelService.welcomeState('club-1')).reason).toBeNull();
  });

  it('posts a free spin to fn_wheel_free_spin and reads it back as free', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        welcome: true,
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
    const r = await DiamondWheelService.welcomeSpin('club-1', 'c1', 'me');
    expect(rpc).toHaveBeenCalledWith('fn_wheel_welcome_spin', {
      p_club_id: 'club-1',
      p_commit_id: 'c1',
      p_client_seed: 'me',
    });
    expect(r.welcome).toBe(true);
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

  it('a paid spin is not a welcome spin', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, spin_id: 'p1', outcome: {}, fairness: {}, balances: {}, pool: {} },
      error: null,
    });
    expect((await DiamondWheelService.spin('club-1', 'c2', 'me')).welcome).toBe(false);
  });

  it('carries the operator switch and pot to fn_wheel_set_free_spin', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'Only The Host’s Owners And Admins Run The Wheel' },
      error: null,
    });
    const r = await DiamondWheelService.setWelcomeSpin('club-1', {
      welcome_spin_enabled: false,
      welcome_budget_chips: 50,
      welcome_budget_period_days: 30,
    });
    expect(rpc).toHaveBeenCalledWith('fn_wheel_set_welcome_spin', {
      p_club_id: 'club-1',
      p_patch: {
        welcome_spin_enabled: false,
        welcome_budget_chips: 50,
        welcome_budget_period_days: 30,
      },
    });
    expect(r).toEqual({ ok: false, error: 'Only The Host’s Owners And Admins Run The Wheel' });
  });
});

/* THE MERGE TEST RETIRED WITH THE MERGE (2026-09-11). There were two histories
   because a free spin was recorded in wheel_free_spins; the welcome spin is a
   row in wheel_spins like any other now and carries its own `welcome` flag, so
   fn_wheel_history returns one list already in order and there is nothing to
   merge. What used to be asserted here is asserted on the server instead, in
   tests/the-welcome-spin-keeps-its-own-books.law.test.ts: a welcome spin says
   it is one, wherever it is shown. */

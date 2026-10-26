import { describe, expect, it } from 'vitest';
import { deriveContext } from './TournamentBrainContext.js';
import { TOURNAMENT_CONTEXT_INCOMPLETE } from '../engine/HorseTournamentPreflop.js';

/*
 * A REBUY OFFER IS NOT A BUBBLE (2026-10-26).
 *
 * One zero-stack player holding an unexpired rebuy prompt used to fail the
 * tournament context closed for the WHOLE event. Live, 2026-10-26: during the
 * rebuy period of the Sunrise Bounty and Morning Free Buy MTTs (150-350
 * players) 20-80% of horse decisions on every table lost tournament stage,
 * ICM, bounty and payout context, and the rate fell to 0% the moment an
 * event's rebuy window closed. The pending seat can only move the money near
 * the bubble, at the final table or in a satellite; there it still fails
 * closed.
 */

const nowMs = Date.parse('2026-10-26T13:30:00.000Z');

function row(paidPlaces: number) {
  return {
    format_contract: 'mtt-v1',
    effective_max_players: 400,
    tournament_type: 'MTT',
    status: 'RUNNING',
    game_type: 'NLH',
    variant: 'freezeout',
    max_players: 400,
    table_size: 8,
    payout_structure: JSON.stringify(
      Array.from({ length: paidPlaces }, (_, i) => ({ place: i + 1, percentage: 100 / paidPlaces }))
    ),
    prize_pool: 10_000,
    bounty_pool: 0,
    buy_in_amount: 90,
    buy_in_fee: 10,
    starting_chips: 5000,
    rebuy_cost: 100,
    rebuy_chips: 5000,
    is_pko: false,
    is_bounty: false,
    is_mystery_bounty: false,
    blind_structure: JSON.stringify([
      { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
      { level: 2, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 10 },
    ]),
    current_level: 0,
    level_started_at: new Date(nowMs - 2 * 60_000).toISOString(),
    started_at: new Date(nowMs - 8 * 60_000).toISOString(),
    late_reg_mins: 0,
    late_reg_levels: 0,
    is_reentry: false,
    max_reentries: 0,
    is_rebuy: true,
    rebuy_levels: 2,
    max_rebuys: 2,
    add_on_available: false,
    addon_cost: 0,
    addon_chips: 0,
    addon_levels: 0,
    addon_period_triggered: false,
    addon_period_started_at: null,
    addon_period_ends_at: null,
    prize_pool_finalized: false,
    on_break: false,
    accelerated_mtt: false,
    big_blind_ante: true,
    authorized_to_register: true,
    satellite_seats: 0,
    satellite_target_id: null,
    satellite_target: null,
  };
}

/** `settled` positive stacks plus `pending` zero-stack players inside a rebuy prompt. */
function context(paidPlaces: number, settled: number, pending: number) {
  const stacks = Array.from({ length: settled }, (_, i) => 5_000 + i);
  return deriveContext(
    row(paidPlaces) as never,
    settled + pending,
    400,
    stacks.reduce((sum, s) => sum + s, 0),
    stacks,
    [],
    [],
    0,
    {},
    nowMs,
    undefined,
    { pendingRecoveryPlayers: pending }
  );
}

describe('a pending rebuy decision and the tournament context', () => {
  it('a big field with no pending offer is complete (fixture control)', () => {
    const c = context(25, 200, 0);
    expect(c.contextIssues).toEqual([]);
    expect(c.contextStatus).toBe('complete');
  });

  it('far from the money, an open offer leaves the context complete and priced without it', () => {
    const c = context(25, 199, 1);
    expect(c.contextStatus).toBe('complete');
    expect(c.contextIssues).toEqual([]);
    expect(c.playersLeft).toBe(199);
    expect(c.stacks).toHaveLength(199);
  });

  it('several open offers in a big field still leave it complete', () => {
    const c = context(25, 300, 7);
    expect(c.contextStatus).toBe('complete');
    expect(c.playersLeft).toBe(300);
  });

  it('near the bubble the pending seat still fails closed', () => {
    const c = context(25, 28, 1);
    expect(c.contextStatus).toBe('incomplete');
    expect(c.contextIssues).toEqual(
      expect.arrayContaining([
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'live_field_recovery_pending',
        'live_field_stack_cardinality_mismatch',
      ])
    );
    expect(c.playersLeft).toBe(29);
  });

  it('at the final table the pending seat still fails closed', () => {
    const c = context(3, 8, 1);
    expect(c.contextStatus).toBe('incomplete');
    expect(c.contextIssues).toContain('live_field_recovery_pending');
  });
});

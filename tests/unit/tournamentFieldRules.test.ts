/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CREATE-TOURNAMENT MODAL COULD NOT CREATE MOST OF WHAT IT OFFERED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found in the game-creation audit, 2026-08-31. Both defects are refusals by
 * `fn_create_tournament`, read from the LIVE function rather than from a
 * migration file (three migrations define it and the live body differs from all
 * three):
 *
 *     v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);
 *     IF v_max_players <= 0 THEN RETURN 'max_players_must_be_positive';
 *     ...
 *     IF jsonb_array_length(v_payouts) >= v_max_players
 *       THEN RETURN 'more_paid_places_than_players';
 *
 * The modal sent `maxPlayers: 0` for freezeout, rebuy, re-entry, bounty,
 * progressive bounty, mystery bounty, satellite AND XMTT — every format that is
 * not a Sit & Go or a Spin — under the comment "0 = unlimited". And its
 * "Heads Up (2)" option selected the `sng6` preset, which pays two places into
 * a two-seat field.
 *
 * The live path could not be probed: `fn_create_tournament` opens with
 * `IF auth.uid() IS NULL THEN RETURN 'not_authenticated'`, so a service-role
 * probe proves only the auth gate. Per CLAUDE.md 11.5 rule 5 the logic is
 * asserted here, and the refusal was READ from the deployed function definition
 * rather than executed against production.
 */

import { describe, it, expect } from 'vitest';
import { fieldCapFor, minPlayersFor, capPaidPlaces } from '../../src/lib/tournamentFieldRules';
import { PAYOUT_STRUCTURES } from '../../src/config/blindStructures';

type Ladder = { place: number; percentage: number }[];
const sng6 = PAYOUT_STRUCTURES.sng6 as Ladder;
const sng9 = PAYOUT_STRUCTURES.sng9 as Ladder;
const mtt50 = PAYOUT_STRUCTURES.mtt50 as Ladder;

describe('the field cap the database will accept', () => {
  it('never returns the zero that made every MTT uncreatable', () => {
    for (const raw of ['0', 0, '', null, undefined, 'unlimited', NaN, -50, '1']) {
      expect(fieldCapFor(raw as never)).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps a real cap the operator chose', () => {
    expect(fieldCapFor('500')).toBe(500);
    expect(fieldCapFor('9')).toBe(9);
    expect(fieldCapFor(30)).toBe(30);
  });

  it('floors a fractional cap rather than sending a decimal seat count', () => {
    expect(fieldCapFor('9.7')).toBe(9);
  });
});

describe('the minimum field', () => {
  it('is the cap itself for a game that starts when it is full', () => {
    // An SNG/Spin starts on maxReached, so any lower minimum never means
    // anything. The modal hard-coded 3 for all of them.
    expect(minPlayersFor(true, 9)).toBe(9);
    expect(minPlayersFor(true, 2)).toBe(2);
    expect(minPlayersFor(true, 3)).toBe(3);
  });

  it('is a real threshold for an MTT, never above its own cap', () => {
    expect(minPlayersFor(false, 500)).toBe(3);
    expect(minPlayersFor(false, 2)).toBe(2);
  });
});

describe('paid places cannot reach the field size', () => {
  it('turns the two-place Sit & Go preset into winner-take-all heads up', () => {
    // THE EXACT COMBINATION THE MODAL OFFERED: "Heads Up (2)" + sng6.
    const capped = capPaidPlaces(sng6, 2);
    expect(capped).toHaveLength(1);
    expect(capped[0]).toEqual({ place: 1, percentage: 100 });
  });

  it('leaves a ladder alone when the field is big enough for it', () => {
    expect(capPaidPlaces(sng9, 9)).toEqual(sng9);
    expect(capPaidPlaces(sng9, 6)).toEqual(sng9);
  });

  it('trims a three-place ladder to two in a three-handed game', () => {
    const capped = capPaidPlaces(sng9, 3);
    expect(capped).toHaveLength(2);
    expect(capped.map((e) => e.place)).toEqual([1, 2]);
  });

  it('always totals exactly 100, because the service refuses anything else', () => {
    for (const field of [2, 3, 4, 5, 9, 50]) {
      for (const preset of [sng6, sng9, mtt50]) {
        const total = capPaidPlaces(preset, field).reduce((a, e) => a + e.percentage, 0);
        expect(Math.round(total * 100) / 100, `field ${field}`).toBe(100);
      }
    }
  });

  it('is strictly fewer places than seats, for every field size', () => {
    for (const field of [2, 3, 4, 5, 6, 9, 18, 50]) {
      const capped = capPaidPlaces(mtt50, field);
      expect(capped.length, `field ${field}`).toBeLessThan(field);
    }
  });

  it('survives an empty or nonsense ladder rather than sending one', () => {
    expect(capPaidPlaces([], 9)).toEqual([{ place: 1, percentage: 100 }]);
    expect(
      capPaidPlaces(
        [
          { place: 1, percentage: 0 },
          { place: 2, percentage: 0 },
        ],
        2
      )
    ).toEqual([{ place: 1, percentage: 100 }]);
  });
});

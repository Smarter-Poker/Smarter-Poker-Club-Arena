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
 *     IF jsonb_array_length(v_payouts) > v_max_players
 *       THEN RETURN 'more_paid_places_than_players';
 *
 * The modal sent `maxPlayers: 0` for freezeout, rebuy, re-entry, bounty,
 * progressive bounty, mystery bounty, satellite AND XMTT — every format that is
 * not a Sit & Go or a Spin — under the comment "0 = unlimited". And its
 * "Heads Up (2)" option selected the `sng6` preset, which pays two places into
 * a two-seat field.
 *
 * THE SECOND RULE'S OPERATOR WAS ITSELF THE BUG (2026-08-31, second pass). It
 * read `>=`, which is not "more paid places than players" — it is "as many
 * paid places as players", a stricter and different claim, and it refused this
 * platform's own product. A Spin & Go is three seats paying three places at
 * 25x and above, and 21 such tournaments are sitting in `tournaments`,
 * completed and paid. `20260831200000_a_spin_pays_three_places_at_three_seats`
 * changes the RPC to `>`, matching `tournaments_creation_guard`, which has
 * enforced `>` on the table itself since the day before. The pins below encode
 * the corrected law: a ladder may pay every seat, and may never pay a place
 * nobody can reach.
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
import { SPIN_TIERS } from '../../src/config/spinSpec';

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

describe('paid places cannot exceed the field size', () => {
  it('leaves the two-place Sit & Go preset intact heads up, because two seats can pay two', () => {
    // THE EXACT COMBINATION THE MODAL OFFERED: "Heads Up (2)" + sng6. This
    // used to be trimmed to winner-take-all, purely because the RPC refused
    // `paid_places >= max_players`. Two places into two seats pays every
    // finisher, which is unusual and legal; the operator chose the preset and
    // this function no longer overrules them on the database's behalf.
    expect(capPaidPlaces(sng6, 2)).toEqual(sng6);
  });

  it('refuses to pay a place nobody can reach', () => {
    // The rule that is actually about poker, and the only one left.
    const capped = capPaidPlaces(mtt50, 4);
    expect(capped).toHaveLength(4);
    expect(capped.map((e) => e.place)).toEqual([1, 2, 3, 4]);
  });

  it('leaves a ladder alone when the field is big enough for it', () => {
    expect(capPaidPlaces(sng9, 9)).toEqual(sng9);
    expect(capPaidPlaces(sng9, 6)).toEqual(sng9);
  });

  it('keeps a three-place ladder whole in a three-handed game', () => {
    // Was "trims a three-place ladder to two". It trimmed because the RPC
    // refused, not because three places into three seats is wrong — and it is
    // how every Spin above 10x pays.
    expect(capPaidPlaces(sng9, 3)).toEqual(sng9);
  });

  it('keeps the Spin ladder un-renormalised at three seats', () => {
    // THE COST OF THE OLD `- 1`, in the numbers an operator would have read.
    // 80 / 12 / 8 trimmed to two places and rescaled by 100/92 is
    // 86.96 / 13.04 — a structure nobody chose, sold as the one they picked,
    // and written to the row that settles the money.
    const spin = SPIN_TIERS.find((t) => t.multiplier === 25)!;
    const ladder: Ladder = spin.payouts.map((pct, i) => ({
      place: i + 1,
      percentage: Math.round(pct * 10000) / 100,
    }));
    expect(ladder).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 12 },
      { place: 3, percentage: 8 },
    ]);
    expect(capPaidPlaces(ladder, 3)).toEqual(ladder);
    expect(capPaidPlaces(ladder, 3).map((e) => e.percentage)).not.toContain(86.96);
  });

  it('always totals exactly 100, because the service refuses anything else', () => {
    for (const field of [2, 3, 4, 5, 9, 50]) {
      for (const preset of [sng6, sng9, mtt50]) {
        const total = capPaidPlaces(preset, field).reduce((a, e) => a + e.percentage, 0);
        expect(Math.round(total * 100) / 100, `field ${field}`).toBe(100);
      }
    }
  });

  it('never pays more places than seats, for every field size', () => {
    // Was "is strictly fewer places than seats" — the client half of the RPC's
    // off-by-one. `<=` is the law both layers now enforce.
    for (const field of [2, 3, 4, 5, 6, 9, 18, 50]) {
      const capped = capPaidPlaces(mtt50, field);
      expect(capped.length, `field ${field}`).toBeLessThanOrEqual(field);
    }
  });

  it('pays as many places as the ladder holds once the field is big enough', () => {
    // The other side of the same law: nothing is dropped for its own sake.
    expect(capPaidPlaces(mtt50, 10)).toEqual(mtt50);
    expect(capPaidPlaces(mtt50, 50)).toEqual(mtt50);
  });

  it('survives an empty or nonsense ladder rather than sending one', () => {
    // The all-zero case is now caught BEFORE the trim: with the cap raised to
    // the field it fits, and a fitting ladder is otherwise returned untouched.
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

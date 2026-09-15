/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND EVENT IS PRICED IN DIAMONDS, ON THE SURFACES A PLAYER READS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Diamond build programme listed one thing still outstanding for Phase 8
 * after the money doors were built and applied: "the lobby's projected ladder
 * and sign-up dialog still speak chips for a Diamond event (display only)".
 * This is the test for the commit that closed it.
 *
 * WHAT WAS ACTUALLY WRONG, because "display only" undersells it. Five browser
 * surfaces priced a place through `placePrize`, and that wrapper answered
 * `UNIT_CENTS_ASSET_NOT_READ` - a cent - on their behalf, because none of them
 * had read the club's asset. So a Diamond event's ladder was computed on the
 * CENT grid:
 *
 *   - the shares were rounded to cents, not to whole Diamonds, so a player was
 *     shown a fraction of a Diamond that no door in this estate will accept -
 *     the custody reserve floors it, the hand settler refuses it, and the
 *     wallet stores diamonds as an integer column;
 *   - the short-field rule inside `computePlacePrize` (`unit > 1`) never
 *     engaged, so a Diamond pool too small to pay every place projected a
 *     ladder that could not be paid at all.
 *
 * Neither is cosmetic. `payoutMath.ts` opens with the sentence this is about:
 * a player must never be shown one number and paid another.
 *
 * NOTHING WAS EVER SHOWN WRONG TO A PLAYER, and this test says so rather than
 * implying otherwise: measured against production on 2026-09-15, zero Diamond
 * tournaments have ever existed and `ca_arena_settings.tournaments_enabled` is
 * false. This was the gap that had to close BEFORE the switch, not damage
 * being repaired after it.
 */
import { describe, it, expect } from 'vitest';

import { computePlacePrize } from '../../src/lib/payoutMath';
import { placePrize, tournamentRowUnitCents } from '../../src/components/tournament/details/types';
import { formatPrizeAtUnit, formatTableChips } from '../../src/utils/format';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

/** The platform Diamond arena, as the three columns the SQL joins describe it. */
const DIAMOND_ARENA = { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null };
const CHIP_CLUB = { id: 'club', asset: 'chips', is_platform: false, union_id: null };

/** A nine-place ladder, the structure the residual rule was written about. */
const NINE_PLACES = [
  { place: 1, percentage: 30 },
  { place: 2, percentage: 20 },
  { place: 3, percentage: 14 },
  { place: 4, percentage: 10 },
  { place: 5, percentage: 8 },
  { place: 6, percentage: 6 },
  { place: 7, percentage: 5 },
  { place: 8, percentage: 4 },
  { place: 9, percentage: 3 },
];

describe('the unit a tournament row reports', () => {
  it('reads the arena embed as an object, which is what PostgREST returns', () => {
    expect(tournamentRowUnitCents({ arena: DIAMOND_ARENA })).toBe(DIAMOND_UNIT_CENTS);
    expect(tournamentRowUnitCents({ arena: CHIP_CLUB })).toBe(CHIP_UNIT_CENTS);
  });

  it('reads it as an array too, so an array shape cannot become a silent "chips"', () => {
    // CLAUDE.md 10.86 rule 2: never coerce an unreadable answer into an empty
    // one. If an array reached the object branch, `.asset` would be undefined
    // and the answer would be a perfectly well-formed, entirely wrong "chips".
    expect(tournamentRowUnitCents({ arena: [DIAMOND_ARENA] })).toBe(DIAMOND_UNIT_CENTS);
    expect(tournamentRowUnitCents({ arena: [CHIP_CLUB] })).toBe(CHIP_UNIT_CENTS);
  });

  it('treats an absent or empty embed as the SQL EXISTS=false branch: a cent', () => {
    expect(tournamentRowUnitCents({ arena: null })).toBe(CHIP_UNIT_CENTS);
    expect(tournamentRowUnitCents({})).toBe(CHIP_UNIT_CENTS);
    expect(tournamentRowUnitCents(null)).toBe(CHIP_UNIT_CENTS);
    expect(tournamentRowUnitCents(undefined)).toBe(CHIP_UNIT_CENTS);
    expect(tournamentRowUnitCents({ arena: [] })).toBe(CHIP_UNIT_CENTS);
  });

  it('requires all three conditions, exactly as fn_ca_tournament_unit_cents does', () => {
    expect(tournamentRowUnitCents({ arena: { ...DIAMOND_ARENA, is_platform: false } })).toBe(
      CHIP_UNIT_CENTS
    );
    expect(tournamentRowUnitCents({ arena: { ...DIAMOND_ARENA, union_id: 'u' } })).toBe(
      CHIP_UNIT_CENTS
    );
    expect(tournamentRowUnitCents({ arena: { ...DIAMOND_ARENA, asset: 'chips' } })).toBe(
      CHIP_UNIT_CENTS
    );
  });
});

describe('the ladder a Diamond event projects', () => {
  it('pays whole Diamonds, where the cent grid paid fractions of one', () => {
    const pool = 513;
    const atCents = NINE_PLACES.map((p) => placePrize(pool, NINE_PLACES, p.place, CHIP_UNIT_CENTS));
    const atDiamonds = NINE_PLACES.map((p) =>
      placePrize(pool, NINE_PLACES, p.place, DIAMOND_UNIT_CENTS)
    );

    // The old answer genuinely carried fractions - this is the defect, stated
    // as an assertion so that it cannot be waved away as theoretical.
    expect(atCents.some((v) => !Number.isInteger(v))).toBe(true);

    // The new one cannot: every place is a whole Diamond.
    for (const v of atDiamonds) expect(Number.isInteger(v)).toBe(true);

    // And the two really do differ, so this is a behaviour change and not a
    // rename that happens to compile.
    expect(atDiamonds).not.toEqual(atCents);
  });

  it('still sums to the pool exactly, which is the ladder rule the unit must not break', () => {
    for (const pool of [513, 1000, 27, 100, 999, 12345]) {
      const places = NINE_PLACES.map((p) =>
        placePrize(pool, NINE_PLACES, p.place, DIAMOND_UNIT_CENTS)
      );
      const total = places.reduce((a, b) => a + b, 0);
      expect(Math.round(total * 100), `pool ${pool} did not sum back to itself`).toBe(
        Math.round(pool * 100)
      );
      for (const v of places) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('pays the places it can, from the top, when the pool holds fewer Diamonds than places', () => {
    // A nine-place event on a four Diamond pool. An indivisible unit cannot be
    // split nine ways; the alternative the cent grid produced was first place
    // paid nothing and ninth paid everything.
    const places = NINE_PLACES.map((p) => placePrize(4, NINE_PLACES, p.place, DIAMOND_UNIT_CENTS));
    expect(places).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(places.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('leaves the chip ladder untouched, by construction rather than by inspection', () => {
    for (const pool of [513, 1000, 27, 483]) {
      for (const p of NINE_PLACES) {
        expect(placePrize(pool, NINE_PLACES, p.place, CHIP_UNIT_CENTS)).toBe(
          computePlacePrize(pool, NINE_PLACES, p.place, CHIP_UNIT_CENTS)
        );
      }
    }
  });
});

describe('the number a player reads', () => {
  it('prints a Diamond prize as a whole Diamond, never with the chip contract', () => {
    expect(formatPrizeAtUnit(17, DIAMOND_UNIT_CENTS)).toBe('17');
    expect(formatPrizeAtUnit(1250, DIAMOND_UNIT_CENTS)).toBe('1,250');
    expect(formatPrizeAtUnit(0, DIAMOND_UNIT_CENTS)).toBe('0');
    // Float noise from the `/ 100` that ends computePlacePrize is absorbed,
    // not re-rounded: the value arriving here is already a whole Diamond.
    expect(formatPrizeAtUnit(16.999999999999996, DIAMOND_UNIT_CENTS)).toBe('17');
  });

  it('is the chip formatter unchanged at the chip unit', () => {
    for (const v of [17.5, 0.5, 0, 1234, 99.99, -7.25]) {
      expect(formatPrizeAtUnit(v, CHIP_UNIT_CENTS)).toBe(formatTableChips(v));
    }
  });

  it('treats a nonsense unit as a cent, never as a grid', () => {
    for (const junk of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPrizeAtUnit(17.5, junk as number)).toBe(formatTableChips(17.5));
    }
  });

  it('never shows a fraction of a Diamond for any place of any pool', () => {
    // The whole point, stated end to end: price it the way the surfaces do,
    // print it the way they print it, and there is no decimal point anywhere.
    for (const pool of [513, 4, 27, 1000, 88, 12345]) {
      for (const p of NINE_PLACES) {
        const text = formatPrizeAtUnit(
          placePrize(pool, NINE_PLACES, p.place, DIAMOND_UNIT_CENTS),
          DIAMOND_UNIT_CENTS
        );
        expect(text, `pool ${pool} place ${p.place} printed "${text}"`).not.toContain('.');
      }
    }
  });
});

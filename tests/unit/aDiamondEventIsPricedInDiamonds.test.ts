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
import fs from 'node:fs';
import path from 'node:path';

import { computePlacePrize } from '../../src/lib/payoutMath';
import { placePrize, tournamentRowUnitCents } from '../../src/components/tournament/details/types';
import {
  formatAwardAtUnit,
  formatChipAward,
  formatPrizeAtUnit,
  formatPrizeCentsAtUnit,
  formatTableChips,
  moneyAdjectiveAtUnit,
  moneySuffixAtUnit,
  moneyWordAtUnit,
} from '../../src/utils/format';
import { formatCents } from '../../src/services/MysteryBountyService';
import { arenaAssetUnitCents } from '../../src/lib/arenaUnitCents';
import {
  CHIP_UNIT_CENTS,
  DIAMOND_UNIT_CENTS,
  UNIT_CENTS_ASSET_NOT_READ,
} from '../../server/src/tournament/tournamentUnit';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SAME RULE OVER CENTS, OVER AWARDS, AND OVER THE WORD (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The prize surfaces took a unit in #4685. The BOUNTY and MYSTERY surfaces did
 * not, and they do not all speak in the same domain:
 *
 *   - a mystery chest is CENTS (`tournament_bounty_chests.amount_cents`, and
 *     the integer cents `fn_mystery_bounty_*` return), so it needs the rule
 *     expressed over cents;
 *   - the "+N" that floats up from a seat when a bounty is taken is an AWARD,
 *     with its own exact-to-the-cent chip contract from the 2026-09-04 audit;
 *   - and several surfaces print a bare figure with no noun at all, which in
 *     the Diamond Arena does not say what was won.
 *
 * Three formatters, one rule: each is `formatPrizeAtUnit` in its own domain,
 * and each returns its existing chip formatter unchanged at the chip unit BY
 * CONSTRUCTION rather than by inspection - which is what the chip assertions
 * below are actually testing.
 */
describe('a mystery chest reads on the grid its event pays on', () => {
  it('prints whole Diamonds for a Diamond chest', () => {
    expect(formatPrizeCentsAtUnit(500_000, DIAMOND_UNIT_CENTS)).toBe('5,000');
    expect(formatPrizeCentsAtUnit(100, DIAMOND_UNIT_CENTS)).toBe('1');
    expect(formatPrizeCentsAtUnit(0, DIAMOND_UNIT_CENTS)).toBe('0');
    // No fraction of a Diamond can reach a player, whatever arrives here.
    for (const cents of [150, 749, 99, 12_345]) {
      expect(formatPrizeCentsAtUnit(cents, DIAMOND_UNIT_CENTS)).not.toContain('.');
    }
  });

  it('is the old chip contract, character for character, at the chip unit', () => {
    // The body MysteryBountyService.formatCents carried before it took a unit.
    const chipContract = (cents: number) => {
      const c = Math.round(cents);
      const rem = Math.abs(c % 100);
      if (rem === 0) return Math.trunc(c / 100).toLocaleString('en-US');
      return (c / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    };
    for (const cents of [0, 100, 750, 99, 500_000, 123_456, -750, -100]) {
      expect(formatPrizeCentsAtUnit(cents, CHIP_UNIT_CENTS), `${cents}`).toBe(chipContract(cents));
    }
  });

  it('is what MysteryBountyService.formatCents now is, so there is one rule and not two', () => {
    for (const cents of [0, 100, 750, 500_000, 123_456]) {
      for (const unit of [CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS]) {
        expect(formatCents(cents, unit)).toBe(formatPrizeCentsAtUnit(cents, unit));
      }
    }
  });

  it('treats a nonsense unit as a cent, never as a grid', () => {
    for (const junk of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPrizeCentsAtUnit(750, junk as number)).toBe(
        formatPrizeCentsAtUnit(750, CHIP_UNIT_CENTS)
      );
    }
  });
});

describe('the "+N" that floats up from a seat', () => {
  it('is formatChipAward unchanged at a chip table', () => {
    for (const v of [1234, 5, 0, 7.5, 0.25, 1234.5, 12.34, -7.5, 12.5000000001]) {
      expect(formatAwardAtUnit(v, CHIP_UNIT_CENTS), `${v}`).toBe(formatChipAward(v));
    }
  });

  it('is a whole Diamond at a Diamond table, with no decimal point anywhere', () => {
    expect(formatAwardAtUnit(12, DIAMOND_UNIT_CENTS)).toBe('+12');
    expect(formatAwardAtUnit(1250, DIAMOND_UNIT_CENTS)).toBe('+1,250');
    expect(formatAwardAtUnit(0, DIAMOND_UNIT_CENTS)).toBe('+0');
    expect(formatAwardAtUnit(-12, DIAMOND_UNIT_CENTS)).toBe('-12');
    // The float noise the chip contract absorbs with a 1e-7 nudge cannot make a
    // Diamond award fractional either.
    expect(formatAwardAtUnit(16.999999999999996, DIAMOND_UNIT_CENTS)).toBe('+17');
    for (const v of [7.5, 0.25, 12.34]) {
      expect(formatAwardAtUnit(v, DIAMOND_UNIT_CENTS)).not.toContain('.');
    }
  });
});

describe('the word a player reads beside the figure', () => {
  it('names Diamonds at a Diamond event and Chips at a chip one', () => {
    expect(moneyWordAtUnit(DIAMOND_UNIT_CENTS)).toBe('Diamonds');
    expect(moneyWordAtUnit(CHIP_UNIT_CENTS)).toBe('Chips');
    expect(moneyAdjectiveAtUnit(DIAMOND_UNIT_CENTS)).toBe('Diamond');
    expect(moneyAdjectiveAtUnit(CHIP_UNIT_CENTS)).toBe('Chip');
  });

  it('adds the noun only where there was none, so chip copy is untouched', () => {
    // This asymmetry is the point: the requirement is that a Diamond figure
    // names its unit, not that every figure in the estate grows a noun. A chip
    // surface that printed "Won 500" still prints "Won 500".
    expect(moneySuffixAtUnit(DIAMOND_UNIT_CENTS)).toBe(' Diamonds');
    expect(moneySuffixAtUnit(CHIP_UNIT_CENTS)).toBe('');
  });

  it('is Title Case, as every player-facing string in this estate is', () => {
    for (const unit of [CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS]) {
      for (const word of [moneyWordAtUnit(unit), moneyAdjectiveAtUnit(unit)]) {
        expect(word).toMatch(/^[A-Z][a-z]+$/);
      }
    }
  });

  it('answers a nonsense unit as a chip event, never as a Diamond one', () => {
    for (const junk of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(moneyWordAtUnit(junk as number)).toBe('Chips');
      expect(moneySuffixAtUnit(junk as number)).toBe('');
    }
  });
});

describe('the unit a table reports, for the surfaces that have no club row', () => {
  it('reads an arena asset that has already been through parseArenaIdentity', () => {
    // `parseArenaIdentity` returns 'diamonds' ONLY for a row satisfying all
    // three of the conditions fn_ca_tournament_unit_cents tests, so the asset
    // on a table state already carries their answer.
    expect(arenaAssetUnitCents('diamonds')).toBe(DIAMOND_UNIT_CENTS);
    expect(arenaAssetUnitCents('chips')).toBe(CHIP_UNIT_CENTS);
  });

  it('names an unread arena rather than answering a quiet cent', () => {
    // CLAUDE.md 10.86 rule 1. The VALUE is a cent, because a cent is the right
    // answer for every tournament that can currently exist; the NAME is what
    // makes "nobody looked" greppable.
    expect(arenaAssetUnitCents(undefined)).toBe(UNIT_CENTS_ASSET_NOT_READ);
    expect(arenaAssetUnitCents(null)).toBe(UNIT_CENTS_ASSET_NOT_READ);
  });

  /**
   * IT READS THE RULE, IT DOES NOT SPELL IT AGAIN (2026-09-20).
   *
   * `arenaAssetUnitCents` lives in `src/` because its input is a browser-only
   * one, which is a real risk: a client copy of a money rule is how two
   * answers start disagreeing. It is safe only while it stays an ADAPTER -
   * every value it returns imported from `tournamentUnit.ts`, and none of the
   * three club conditions restated here. This pins that.
   */
  it('imports every value it returns and re-derives none of the club conditions', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/lib/arenaUnitCents.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(
      /import\s*\{[^}]*CHIP_UNIT_CENTS[^}]*DIAMOND_UNIT_CENTS[^}]*UNIT_CENTS_ASSET_NOT_READ[^}]*\}\s*from\s*'\.\.\/\.\.\/server\/src\/tournament\/tournamentUnit'/
    );
    for (const condition of ['is_platform', 'union_id', "asset === 'chips' &&"]) {
      expect(
        code,
        `src/lib/arenaUnitCents.ts re-derives the club rule (${condition}). It must read the ` +
          `answer parseArenaIdentity already gave, never test the three columns a second time - ` +
          `tournamentUnitCents in server/src/tournament/tournamentUnit.ts is the only place ` +
          `TypeScript answers that.`
      ).not.toContain(condition);
    }
    // And no literal grid: the numbers are the imported constants.
    expect(code, 'a bare 100 is the Diamond unit spelled a second time').not.toMatch(
      /return\s+\d+\s*;/
    );
  });
});

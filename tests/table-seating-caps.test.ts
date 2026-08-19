/**
 * Dan 2026-08-19, verbatim:
 *   "YOU CAN'T HAVE 8 MAX PLO6. ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5"
 *
 * Nothing enforced a per-variant seat cap. The create-table modal offered the
 * same three options for every game, so PLO6 at 9-max was one click away.
 * Production has 76 plo6 tables at 7-max and 10,054 plo5 tables at 8 or 9.
 *
 * It is a dealing constraint too, not just a house rule: hole cards and the
 * board come out of ONE 52-card deck, and PokerEngine.deal() THROWS when it
 * cannot fill a request, so an over-seated table fails mid-hand rather than
 * degrading.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_SEATS,
  clampSeatsForVariant,
  isSeatCountLegal,
  maxSeatsForVariant,
  seatOptionsForVariant,
} from '../src/config/tableSeating';

/** Hole cards per player, by variant. */
const HOLE_CARDS: Record<string, number> = {
  nlh: 2,
  short_deck: 2,
  plo4: 4,
  plo8: 4,
  plo5: 5,
  plo6: 6,
  pineapple: 3,
};
const BOARD = 5;
const DECK = 52;

describe("Dan's caps", () => {
  it('PLO6 is 6-max', () => {
    expect(maxSeatsForVariant('plo6')).toBe(6);
  });

  it('PLO5 is 7-max', () => {
    expect(maxSeatsForVariant('plo5')).toBe(7);
  });

  it('everything else stays full ring', () => {
    for (const v of ['nlh', 'plo4', 'plo8', 'short_deck', 'pineapple']) {
      expect(maxSeatsForVariant(v)).toBe(DEFAULT_MAX_SEATS);
    }
  });

  it('is case-insensitive and safe on a missing variant', () => {
    expect(maxSeatsForVariant('PLO6')).toBe(6);
    expect(maxSeatsForVariant(null)).toBe(DEFAULT_MAX_SEATS);
    expect(maxSeatsForVariant(undefined)).toBe(DEFAULT_MAX_SEATS);
  });
});

describe('the caps keep every variant inside one 52-card deck', () => {
  for (const [variant, hole] of Object.entries(HOLE_CARDS)) {
    it(`${variant} at its cap does not overdraw the deck`, () => {
      const needed = hole * maxSeatsForVariant(variant) + BOARD;
      expect(needed).toBeLessThanOrEqual(DECK);
    });
  }

  it('PLO6 at 9-max WOULD overdraw — which is why the cap exists', () => {
    expect(HOLE_CARDS.plo6 * 9 + BOARD).toBeGreaterThan(DECK); // 59
  });

  it('PLO6 at its cap leaves real headroom, not two cards', () => {
    expect(DECK - (HOLE_CARDS.plo6 * 6 + BOARD)).toBeGreaterThanOrEqual(10);
  });

  it('PLO5 at 9-max left only two spare cards', () => {
    expect(DECK - (HOLE_CARDS.plo5 * 9 + BOARD)).toBe(2);
  });
});

describe('isSeatCountLegal', () => {
  it('rejects the configurations found in production', () => {
    expect(isSeatCountLegal('plo6', 7)).toBe(false);
    expect(isSeatCountLegal('plo6', 8)).toBe(false);
    expect(isSeatCountLegal('plo5', 8)).toBe(false);
    expect(isSeatCountLegal('plo5', 9)).toBe(false);
  });

  it('accepts the legal ones', () => {
    expect(isSeatCountLegal('plo6', 6)).toBe(true);
    expect(isSeatCountLegal('plo5', 7)).toBe(true);
    expect(isSeatCountLegal('nlh', 9)).toBe(true);
  });

  it('never allows a table below heads-up', () => {
    expect(isSeatCountLegal('nlh', 1)).toBe(false);
  });
});

describe('clampSeatsForVariant', () => {
  it('pulls a stale seat count down when the variant tightens', () => {
    expect(clampSeatsForVariant('plo6', 9)).toBe(6);
    expect(clampSeatsForVariant('plo5', 9)).toBe(7);
  });

  it('leaves a legal count alone', () => {
    expect(clampSeatsForVariant('plo6', 6)).toBe(6);
    expect(clampSeatsForVariant('nlh', 9)).toBe(9);
  });

  it('survives rubbish input', () => {
    expect(clampSeatsForVariant('plo6', NaN)).toBe(2);
    expect(clampSeatsForVariant('plo6', 0)).toBe(2);
  });
});

describe('seatOptionsForVariant (what the builder may offer)', () => {
  it('never offers a seat count above the cap', () => {
    for (const v of Object.keys(HOLE_CARDS)) {
      for (const o of seatOptionsForVariant(v)) {
        expect(o.value).toBeLessThanOrEqual(maxSeatsForVariant(v));
      }
    }
  });

  it('PLO6 offers only heads-up and 6-max', () => {
    expect(seatOptionsForVariant('plo6').map((o) => o.value)).toEqual([2, 6]);
  });

  it('PLO5 tops out at 7', () => {
    expect(seatOptionsForVariant('plo5').map((o) => o.value)).toEqual([2, 6, 7]);
  });

  it('NLH still offers full ring', () => {
    expect(seatOptionsForVariant('nlh').map((o) => o.value)).toContain(9);
  });
});

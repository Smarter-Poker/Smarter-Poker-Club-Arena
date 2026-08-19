/**
 * Seat caps. Dan, 2026-08-19, in three messages:
 *
 *   "YOU CAN'T HAVE 8 MAX PLO6. ITS ALWAYS 6 MAX FOR PLO 6 AND 7 MAX FOR PLO5"
 *   "...CHANGE THESE TO ALLOW FOR RUNNING IT MULTIPLE TIMES... OR 3 TIMES"
 *   "BUT THIS IS ONLY IF THE TABLE IS A RUN IT TWICE OR THREE TIMES TABLE, IF
 *    ITS NOT THEN YOU CAN GO TO MAX POSSIBLE PLAYERS IF ITS A RUN IT ONCE
 *    TABLE."
 *
 * Two independent constraints, and the tighter one wins:
 *   HOUSE — PLO6 is 6-max, PLO5 is 7-max, always.
 *   DECK  — only binds a Run It Twice table, which must deal up to THREE
 *           boards out of what the deal left behind. Worst case is a preflop
 *           all-in: no board exists, so every run needs a full five cards.
 */
import { describe, it, expect } from 'vitest';
import {
  BOARD_CARDS,
  DEFAULT_MAX_SEATS,
  MAX_RIT_RUNS,
  canRunItNTimes,
  clampSeatsForVariant,
  deckSizeForVariant,
  holeCardsForVariant,
  houseMaxSeatsForVariant,
  isSeatCountLegal,
  maxSeatsForVariant,
  remainderAfterDeal,
  seatOptionsForVariant,
} from '../src/config/tableSeating';

const RIT = { runItTwice: true };
const ONCE = { runItTwice: false };
const VARIANTS = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'pineapple', 'short_deck'];

describe("the caps Dan named", () => {
  it('PLO6 is 5-max with Run It Twice, 6-max without', () => {
    expect(maxSeatsForVariant('plo6', RIT)).toBe(5);
    expect(maxSeatsForVariant('plo6', ONCE)).toBe(6);
  });

  it('PLO5 is 6-max with Run It Twice, 7-max without', () => {
    expect(maxSeatsForVariant('plo5', RIT)).toBe(6);
    expect(maxSeatsForVariant('plo5', ONCE)).toBe(7);
  });

  it('PLO4 is 8-max with Run It Twice, full ring without', () => {
    expect(maxSeatsForVariant('plo4', RIT)).toBe(8);
    expect(maxSeatsForVariant('plo4', ONCE)).toBe(9);
  });

  it('the house rule stands on its own, independent of the deck', () => {
    expect(houseMaxSeatsForVariant('plo6')).toBe(6);
    expect(houseMaxSeatsForVariant('plo5')).toBe(7);
    expect(houseMaxSeatsForVariant('nlh')).toBe(DEFAULT_MAX_SEATS);
  });

  it('assumes Run It Twice when not told — new tables default to it', () => {
    expect(maxSeatsForVariant('plo6')).toBe(maxSeatsForVariant('plo6', RIT));
  });

  it('is case-insensitive and safe on a missing variant', () => {
    expect(maxSeatsForVariant('PLO6', RIT)).toBe(5);
    expect(maxSeatsForVariant(null)).toBe(DEFAULT_MAX_SEATS);
    expect(maxSeatsForVariant(undefined)).toBe(DEFAULT_MAX_SEATS);
  });
});

describe('every cap can actually run it three times', () => {
  for (const v of VARIANTS) {
    it(`${v} at its RIT cap has cards for ${MAX_RIT_RUNS} full boards`, () => {
      const seats = maxSeatsForVariant(v, RIT);
      expect(canRunItNTimes(v, seats, MAX_RIT_RUNS)).toBe(true);
    });

    it(`${v} at its RIT cap keeps a spare board in reserve`, () => {
      const seats = maxSeatsForVariant(v, RIT);
      const left = remainderAfterDeal(v, seats);
      // 3 runs plus one board of headroom, so rabbit hunt cannot tip it over.
      expect(left).toBeGreaterThanOrEqual(BOARD_CARDS * MAX_RIT_RUNS + BOARD_CARDS);
    });

    it(`${v} at its run-once cap still fits a board`, () => {
      const seats = maxSeatsForVariant(v, ONCE);
      expect(remainderAfterDeal(v, seats)).toBeGreaterThanOrEqual(BOARD_CARDS);
    });
  }
});

describe('the numbers behind the caps', () => {
  it('a PLO6 run-it-3 table leaves 22 cards, not 1', () => {
    expect(remainderAfterDeal('plo6', 5)).toBe(22);
    // The rejected cap of 6 cleared three runs by exactly one card.
    expect(remainderAfterDeal('plo6', 6) - BOARD_CARDS * MAX_RIT_RUNS).toBe(1);
  });

  it('a PLO5 run-it-3 table leaves 22 cards, not 2', () => {
    expect(remainderAfterDeal('plo5', 6)).toBe(22);
    expect(remainderAfterDeal('plo5', 7) - BOARD_CARDS * MAX_RIT_RUNS).toBe(2);
  });

  it('PLO6 at 9-max would overdraw the deck outright', () => {
    expect(holeCardsForVariant('plo6') * 9 + BOARD_CARDS).toBeGreaterThan(
      deckSizeForVariant('plo6')
    );
  });

  it('short deck is measured against 36 cards, not 52', () => {
    expect(deckSizeForVariant('short_deck')).toBe(36);
    expect(canRunItNTimes('short_deck', maxSeatsForVariant('short_deck', RIT), 3)).toBe(true);
  });

  it('plo8 deals four cards like plo4, and caps the same', () => {
    expect(holeCardsForVariant('plo8')).toBe(4);
    expect(maxSeatsForVariant('plo8', RIT)).toBe(maxSeatsForVariant('plo4', RIT));
  });
});

describe('isSeatCountLegal', () => {
  it('rejects the configurations found in production', () => {
    expect(isSeatCountLegal('plo6', 7, RIT)).toBe(false);
    expect(isSeatCountLegal('plo5', 9, RIT)).toBe(false);
    expect(isSeatCountLegal('plo5', 8, RIT)).toBe(false);
  });

  it('still rejects them on a run-once table, via the house rule', () => {
    expect(isSeatCountLegal('plo6', 7, ONCE)).toBe(false);
    expect(isSeatCountLegal('plo5', 8, ONCE)).toBe(false);
  });

  it('accepts the legal ones', () => {
    expect(isSeatCountLegal('plo6', 5, RIT)).toBe(true);
    expect(isSeatCountLegal('plo6', 6, ONCE)).toBe(true);
    expect(isSeatCountLegal('nlh', 9, RIT)).toBe(true);
  });

  it('never allows a table below heads-up', () => {
    expect(isSeatCountLegal('nlh', 1, RIT)).toBe(false);
  });
});

describe('clampSeatsForVariant', () => {
  it('pulls a seat count down when Run It Twice is switched on', () => {
    expect(clampSeatsForVariant('plo6', 6, RIT)).toBe(5);
    expect(clampSeatsForVariant('plo5', 7, RIT)).toBe(6);
    expect(clampSeatsForVariant('plo4', 9, RIT)).toBe(8);
  });

  it('leaves a legal count alone', () => {
    expect(clampSeatsForVariant('plo6', 5, RIT)).toBe(5);
    expect(clampSeatsForVariant('nlh', 9, RIT)).toBe(9);
  });

  it('survives rubbish input', () => {
    expect(clampSeatsForVariant('plo6', NaN, RIT)).toBe(2);
    expect(clampSeatsForVariant('plo6', 0, RIT)).toBe(2);
  });
});

describe('seatOptionsForVariant (what the builder may offer)', () => {
  it('never offers a seat count above the cap, in either mode', () => {
    for (const v of VARIANTS) {
      for (const opts of [RIT, ONCE]) {
        for (const o of seatOptionsForVariant(v, opts)) {
          expect(o.value).toBeLessThanOrEqual(maxSeatsForVariant(v, opts));
        }
      }
    }
  });

  it('PLO6 tops out at 5 with Run It Twice and 6 without', () => {
    const top = (opts: object) => Math.max(...seatOptionsForVariant('plo6', opts).map((o) => o.value));
    expect(top(RIT)).toBe(5);
    expect(top(ONCE)).toBe(6);
  });

  it('NLH still offers full ring either way', () => {
    expect(seatOptionsForVariant('nlh', RIT).map((o) => o.value)).toContain(9);
    expect(seatOptionsForVariant('nlh', ONCE).map((o) => o.value)).toContain(9);
  });
});

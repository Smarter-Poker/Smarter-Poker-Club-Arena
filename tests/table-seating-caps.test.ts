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
  isSeatCountLegal,
  maxSeatsForVariant,
  remainderAfterDeal,
  ritHeadroom,
  seatOptionsForVariant,
} from '../src/config/tableSeating';

const VARIANTS = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'pineapple', 'short_deck'];

describe('the law Dan set (cash games)', () => {
  it('PLO6 is 6-max', () => expect(maxSeatsForVariant('plo6')).toBe(6));
  it('PLO5 is 7-max', () => expect(maxSeatsForVariant('plo5')).toBe(7));
  it('PLO4 is 8-max', () => expect(maxSeatsForVariant('plo4')).toBe(8));
  it('PLO8 deals four cards like PLO4 and caps the same', () => {
    expect(holeCardsForVariant('plo8')).toBe(4);
    expect(maxSeatsForVariant('plo8')).toBe(8);
  });
  it('everything else is full ring', () => {
    for (const v of ['nlh', 'short_deck', 'pineapple']) {
      expect(maxSeatsForVariant(v)).toBe(DEFAULT_MAX_SEATS);
    }
  });
  it('is one flat number per variant, not a function of any table setting', () => {
    // Regression guard: the cap briefly depended on run_it_twice, which meant
    // a seat count that moved when a toggle moved. Dan replaced it with a
    // single number, and maxSeatsForVariant takes no options at all now.
    expect(maxSeatsForVariant.length).toBe(1);
  });
  it('is case-insensitive and safe on a missing variant', () => {
    expect(maxSeatsForVariant('PLO6')).toBe(6);
    expect(maxSeatsForVariant(null)).toBe(DEFAULT_MAX_SEATS);
    expect(maxSeatsForVariant(undefined)).toBe(DEFAULT_MAX_SEATS);
  });
});

describe('every cash cap still fits three run-outs', () => {
  for (const v of VARIANTS) {
    it(`${v} at its cap can deal ${MAX_RIT_RUNS} full boards`, () => {
      expect(canRunItNTimes(v, maxSeatsForVariant(v), MAX_RIT_RUNS)).toBe(true);
      // The margin is the thing to watch: plo6 has ONE spare card.
      expect(ritHeadroom(v)).toBeGreaterThanOrEqual(0);
    });
  }

  it('records how tight the tightest caps really are', () => {
    expect(ritHeadroom('plo6')).toBe(1);
    expect(ritHeadroom('plo5')).toBe(2);
    expect(ritHeadroom('plo4')).toBe(5);
  });

  it('PLO6 at 9-max would overdraw the deck outright', () => {
    expect(holeCardsForVariant('plo6') * 9 + BOARD_CARDS).toBeGreaterThan(
      deckSizeForVariant('plo6')
    );
  });

  it('short deck is measured against 36 cards, not 52', () => {
    expect(deckSizeForVariant('short_deck')).toBe(36);
    expect(remainderAfterDeal('short_deck', 9)).toBe(18);
  });
});

describe('isSeatCountLegal', () => {
  it('rejects the configurations that were live in production', () => {
    expect(isSeatCountLegal('plo6', 7)).toBe(false);
    expect(isSeatCountLegal('plo5', 9)).toBe(false);
    expect(isSeatCountLegal('plo5', 8)).toBe(false);
    expect(isSeatCountLegal('plo4', 9)).toBe(false);
  });
  it('accepts the legal ones', () => {
    expect(isSeatCountLegal('plo6', 6)).toBe(true);
    expect(isSeatCountLegal('plo5', 7)).toBe(true);
    expect(isSeatCountLegal('plo4', 8)).toBe(true);
    expect(isSeatCountLegal('nlh', 9)).toBe(true);
  });
  it('never allows a table below heads-up', () => {
    expect(isSeatCountLegal('nlh', 1)).toBe(false);
  });
});

describe('clampSeatsForVariant', () => {
  it('pulls an over-cap seat count down', () => {
    expect(clampSeatsForVariant('plo6', 9)).toBe(6);
    expect(clampSeatsForVariant('plo5', 9)).toBe(7);
    expect(clampSeatsForVariant('plo4', 9)).toBe(8);
  });
  it('leaves a SMALLER table alone — the law is a ceiling, not a target', () => {
    // This is the mistake that inflated 200 Spin & Go tables from 3 to 8.
    expect(clampSeatsForVariant('plo4', 3)).toBe(3);
    expect(clampSeatsForVariant('plo4', 6)).toBe(6);
    expect(clampSeatsForVariant('plo5', 6)).toBe(6);
  });
  it('survives rubbish input', () => {
    expect(clampSeatsForVariant('plo6', NaN)).toBe(2);
    expect(clampSeatsForVariant('plo6', 0)).toBe(2);
  });
});

describe('seatOptionsForVariant (what the builder may offer)', () => {
  it('never offers a seat count above the cap', () => {
    for (const v of VARIANTS) {
      for (const o of seatOptionsForVariant(v)) {
        expect(o.value).toBeLessThanOrEqual(maxSeatsForVariant(v));
      }
    }
  });
  it('PLO6 tops out at 6, PLO5 at 7, PLO4 at 8', () => {
    const top = (v: string) => Math.max(...seatOptionsForVariant(v).map((o) => o.value));
    expect(top('plo6')).toBe(6);
    expect(top('plo5')).toBe(7);
    expect(top('plo4')).toBe(8);
  });
  it('still offers small tables, not only the cap', () => {
    expect(seatOptionsForVariant('plo4').map((o) => o.value)).toContain(2);
  });
  it('NLH still offers full ring', () => {
    expect(seatOptionsForVariant('nlh').map((o) => o.value)).toContain(9);
  });
});

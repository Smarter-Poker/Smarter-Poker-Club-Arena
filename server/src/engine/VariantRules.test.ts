/**
 * VARIANT RULES — the four facts that decide what game is being played.
 *
 * Adding `flo8` on 2026-08-23 found these facts decided independently in five
 * places, every one by a substring test on the variant string. `flo8` contains
 * no "plo", so the same table would have been dealt two hole cards, evaluated
 * as Hold'em, split no low, and read by the horses as a Hold'em board — while
 * calling itself Omaha Hi-Lo.
 *
 * `determineWinners` is one of the five. That one AWARDS THE POT. These tests
 * exist so a variant can never again be half-taught to the engine.
 */
import { describe, it, expect } from 'vitest';
import {
  holeCardCount,
  isOmahaVariant,
  isHiLoVariant,
  isShortDeckVariant,
  deckSizeFor,
  maxSeatsFor,
  isKnownVariant,
  KNOWN_VARIANTS,
  DEFAULT_HOLE_CARDS,
  FULL_DECK_SIZE,
  SHORT_DECK_SIZE,
} from './VariantRules.js';
import { bettingStructureFor } from './BettingStructure.js';

describe('holeCardCount', () => {
  it('deals four to every Omaha, including the one spelled without "plo"', () => {
    expect(holeCardCount('plo4')).toBe(4);
    expect(holeCardCount('plo8')).toBe(4);
    expect(holeCardCount('flo8')).toBe(4);
  });

  it('deals five and six to the big-card Omahas', () => {
    expect(holeCardCount('plo5')).toBe(5);
    expect(holeCardCount('plo6')).toBe(6);
  });

  it("deals two to both Hold'ems - limit changes the betting, not the deal", () => {
    expect(holeCardCount('nlh')).toBe(2);
    expect(holeCardCount('flh')).toBe(2);
    expect(holeCardCount('short_deck')).toBe(2);
  });

  it('deals three to Pineapple', () => {
    expect(holeCardCount('pineapple')).toBe(3);
  });

  it('is case-insensitive - the client holds "PLO4", the column holds "plo4"', () => {
    expect(holeCardCount('PLO6')).toBe(6);
    expect(holeCardCount('FLO8')).toBe(4);
  });

  it('falls back to two rather than throwing on the unknown', () => {
    expect(holeCardCount('a_variant_invented_next_year')).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCount(undefined)).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCount(null)).toBe(DEFAULT_HOLE_CARDS);
    expect(holeCardCount('')).toBe(DEFAULT_HOLE_CARDS);
  });
});

describe('isOmahaVariant', () => {
  it('includes flo8 - the exactly-two rule is about the HAND, not the betting', () => {
    expect(isOmahaVariant('flo8')).toBe(true);
  });

  it('includes every plo variant', () => {
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8']) {
      expect(isOmahaVariant(v)).toBe(true);
    }
  });

  it("excludes both Hold'ems, Short Deck and Pineapple", () => {
    for (const v of ['nlh', 'flh', 'short_deck', 'pineapple']) {
      expect(isOmahaVariant(v)).toBe(false);
    }
  });

  it('is not fooled by the substring test it replaced', () => {
    // The old rule everywhere was `v.startsWith('plo')`.
    expect('flo8'.startsWith('plo')).toBe(false);
    expect(isOmahaVariant('flo8')).toBe(true);
  });
});

describe('isHiLoVariant', () => {
  it('splits the pot in both 8-or-better games', () => {
    expect(isHiLoVariant('plo8')).toBe(true);
    expect(isHiLoVariant('flo8')).toBe(true);
  });

  it('does not split anywhere else', () => {
    for (const v of ['nlh', 'flh', 'plo4', 'plo5', 'plo6', 'short_deck', 'pineapple']) {
      expect(isHiLoVariant(v)).toBe(false);
    }
  });
});

describe('isShortDeckVariant / deckSizeFor', () => {
  it('strips the deck for Short Deck only', () => {
    expect(isShortDeckVariant('short_deck')).toBe(true);
    expect(deckSizeFor('short_deck')).toBe(SHORT_DECK_SIZE);
    for (const v of ['nlh', 'flh', 'plo6', 'flo8']) {
      expect(isShortDeckVariant(v)).toBe(false);
      expect(deckSizeFor(v)).toBe(FULL_DECK_SIZE);
    }
  });
});

describe('maxSeatsFor', () => {
  it('never promises more seats than the deck can physically deal', () => {
    for (const v of KNOWN_VARIANTS) {
      const needed = maxSeatsFor(v) * holeCardCount(v) + 5;
      expect(needed).toBeLessThanOrEqual(deckSizeFor(v));
    }
  });

  it('gives the known table limits', () => {
    expect(maxSeatsFor('nlh')).toBeGreaterThanOrEqual(9);
    // 6 cards each + 5 board must fit in 52: floor(47/6) = 7.
    expect(maxSeatsFor('plo6')).toBe(7);
    // Short deck: floor(31/2) = 15, comfortably above any real table.
    expect(maxSeatsFor('short_deck')).toBeGreaterThanOrEqual(9);
  });
});

describe('the variant table is complete', () => {
  it('knows every variant the engine can be handed', () => {
    for (const v of [
      'nlh',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'pineapple',
      'short_deck',
      'flh',
      'flo8',
    ]) {
      expect(isKnownVariant(v)).toBe(true);
    }
    expect(isKnownVariant('ofc')).toBe(false);
    expect(isKnownVariant(undefined)).toBe(false);
  });

  it('agrees with BettingStructure on every variant it knows', () => {
    // The two modules answer different questions, but a variant known to one
    // and not the other is how half-taught variants happen. Every variant here
    // must resolve to a real structure, and only the two limit games may be
    // fixed_limit.
    for (const v of KNOWN_VARIANTS) {
      const s = bettingStructureFor(v);
      expect(['no_limit', 'pot_limit', 'fixed_limit']).toContain(s);
      if (s === 'fixed_limit') expect(['flh', 'flo8']).toContain(v);
    }
    expect(bettingStructureFor('flh')).toBe('fixed_limit');
    expect(bettingStructureFor('flo8')).toBe('fixed_limit');
  });

  it("pairs the hi-lo games with Omaha, never with a Hold'em", () => {
    for (const v of KNOWN_VARIANTS) {
      if (isHiLoVariant(v)) expect(isOmahaVariant(v)).toBe(true);
    }
  });

  it('gives every Omaha at least four cards', () => {
    for (const v of KNOWN_VARIANTS) {
      if (isOmahaVariant(v)) expect(holeCardCount(v)).toBeGreaterThanOrEqual(4);
    }
  });
});

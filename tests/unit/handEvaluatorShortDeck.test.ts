/**
 * SHORT DECK IS A DIFFERENT GAME AND THE DISPLAY HAS TO KNOW IT.
 *
 * `bestFive` fell through to the hold'em search on short deck, and the note in
 * the file said that was fine "because short deck is not BBJ-eligible". True of
 * the jackpot, irrelevant to everything else: this evaluator also names the made
 * hand in the table's own Previous Hand rundown, and production holds **41,153
 * short-deck hands**.
 *
 * With 36 cards two things change (Bible V8 Appendix D, and
 * server/src/engine/PokerEngine.ts evaluate5Cards):
 *
 *   a FLUSH beats a FULL HOUSE — it is harder to make;
 *   the lowest straight is A-6-7-8-9, not A-2-3-4-5.
 *
 * Before this, a short-deck player holding a flush against a full house saw the
 * full house drawn as the best hand — the hand that LOST the money — and the
 * A-6-7-8-9 wheel was called a high card.
 *
 * The engine is the authority; this only draws what it decided. These tests
 * exist so the two cannot drift, because a display that disagrees with the
 * engine on a showdown is worse than no display.
 */
import { describe, it, expect } from 'vitest';
import {
  bestFive,
  scoreFive,
  compareScore,
  isShortDeckVariant,
} from '../../src/utils/handEvaluator';
import type { Card } from '../../src/components/table/CardImage';

const c = (s: string): Card => ({ rank: s[0] as Card['rank'], suit: s[1] as Card['suit'] });
const hand = (s: string) => s.split(' ').map(c);

const FLUSH = hand('Kh Th 9h 8h 6h');
const FULL_HOUSE = hand('9c 9d 9s 7c 7d');

describe('short deck — a flush beats a full house', () => {
  it('ranks the flush above the full house', () => {
    expect(compareScore(scoreFive(FLUSH, true), scoreFive(FULL_HOUSE, true))).toBeGreaterThan(0);
  });

  it('still ranks the full house higher in every other game', () => {
    expect(compareScore(scoreFive(FLUSH, false), scoreFive(FULL_HOUSE, false))).toBeLessThan(0);
  });

  it('names each hand correctly rather than by slot', () => {
    // The categories are swapped internally; the label must follow the swap or
    // a flush gets announced as a full house.
    const flushHand = bestFive(hand('Kh Th'), hand('9h 8h 6h 7c 7d'), 'short_deck')!;
    expect(flushHand.name).toBe('Flush');

    const boat = bestFive(hand('9c 9d'), hand('9s 7c 7d Kh Th'), 'short_deck')!;
    expect(boat.name).toBe('Full House');
  });

  it('decides a showdown between two players the short-deck way', () => {
    /**
     * This is where the swap actually bites, and it is worth being precise
     * about why. With only two hole cards a flush and a full house compete for
     * the same board slots, so a single holding almost never has both — the
     * swap rarely changes which five ONE player plays. It decides which of TWO
     * players won, which is a comparison, so that is what is asserted.
     */
    const flushPlayer = bestFive(hand('Kh Th'), hand('9h 8h 6h 9c 7d'), 'short_deck')!;
    const boatPlayer = bestFive(hand('9s 7c'), hand('9h 8h 6h 9c 7d'), 'short_deck')!;
    expect(flushPlayer.name).toBe('Flush');
    expect(boatPlayer.name).toBe('Full House');
    expect(compareScore(flushPlayer, boatPlayer)).toBeGreaterThan(0);
  });
});

describe('short deck — the wheel is A-6-7-8-9', () => {
  it('reads A 6 7 8 9 as a straight', () => {
    const s = scoreFive(hand('Ac 9d 8h 7s 6c'), true);
    expect(s.category).toBe(5); // STRAIGHT
    // Five-high in the sense that matters: the ace plays low, so it is the
    // WEAKEST straight, not an ace-high one.
    expect(s.tiebreak[0]).toBe(5);
  });

  it('is beaten by any higher straight, as the weakest one should be', () => {
    const wheel = scoreFive(hand('Ac 9d 8h 7s 6c'), true);
    const tenHigh = scoreFive(hand('Td 9c 8s 7h 6d'), true);
    expect(compareScore(tenHigh, wheel)).toBeGreaterThan(0);
  });

  it('makes a steel wheel a straight flush, not a flush', () => {
    const s = scoreFive(hand('Ah 9h 8h 7h 6h'), true);
    expect(s.category).toBe(9); // STRAIGHT_FLUSH
    expect(s.tiebreak[0]).toBe(5);
  });

  it('does NOT read A 6 7 8 9 as a straight in a full deck', () => {
    // With a 36-card deck there is nothing between the 6 and the ace. With 52
    // there is, so this is just ace-high.
    expect(scoreFive(hand('Ac 9d 8h 7s 6c'), false).category).toBe(1); // HIGH_CARD
  });

  it('keeps the standard wheel working where it belongs', () => {
    const s = scoreFive(hand('Ac 5d 4h 3s 2c'), false);
    expect(s.category).toBe(5);
    expect(s.tiebreak[0]).toBe(5);
  });
});

describe('isShortDeckVariant', () => {
  it('matches what the database actually stores', () => {
    // `short_deck` is the value in hand_history.game_variant — 41,153 rows.
    expect(isShortDeckVariant('short_deck')).toBe(true);
    expect(isShortDeckVariant('SHORT_DECK')).toBe(true);
    expect(isShortDeckVariant('sixplus')).toBe(true);
  });

  it('does not catch anything else', () => {
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'pineapple', '', null]) {
      expect(isShortDeckVariant(v)).toBe(false);
    }
  });

  it('leaves every other variant deciding the same showdown the other way', () => {
    const flushPlayer = bestFive(hand('Kh Th'), hand('9h 8h 6h 9c 7d'), 'nlh')!;
    const boatPlayer = bestFive(hand('9s 7c'), hand('9h 8h 6h 9c 7d'), 'nlh')!;
    expect(flushPlayer.name).toBe('Flush');
    expect(boatPlayer.name).toBe('Full House');
    // Same two hands, opposite result. That is the whole of the rule.
    expect(compareScore(boatPlayer, flushPlayer)).toBeGreaterThan(0);
  });
});

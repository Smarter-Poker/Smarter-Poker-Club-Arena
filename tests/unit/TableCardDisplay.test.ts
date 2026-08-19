/**
 * CARD DISPLAY HELPERS (2026-08-19).
 *
 * Extracted from TablePage.tsx. Small, pure, and easy to break silently — a
 * wrong suit letter shows the wrong card face, and a wrong sort puts the hero's
 * hand in the wrong order right before they act.
 */
import { describe, it, expect } from 'vitest';
import {
  ENGINE_SUIT_MAP,
  RANK_ORDER,
  sortCardsByRank,
  GAME_VARIANT_LABELS,
  getGameVariantLabel,
} from '../../src/lib/tableCardDisplay';
import type { Card } from '../../src/components/table/SeatSlot';

const card = (rank: string, suit: Card['suit'] = 'h') => ({ rank, suit }) as Card;

describe('ENGINE_SUIT_MAP', () => {
  it('maps every suit the engine sends', () => {
    expect(ENGINE_SUIT_MAP).toEqual({ hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's' });
  });

  it('has four distinct letters — no two suits share a face', () => {
    expect(new Set(Object.values(ENGINE_SUIT_MAP)).size).toBe(4);
  });
});

describe('RANK_ORDER', () => {
  it('orders the whole deck low to high, ace high', () => {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const vals = ranks.map((r) => RANK_ORDER[r]);
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
    expect(RANK_ORDER.A).toBe(14);
  });

  it('accepts both "10" and "T" for the ten', () => {
    expect(RANK_ORDER['10']).toBe(10);
    expect(RANK_ORDER.T).toBe(10);
  });
});

describe('sortCardsByRank — Bible V8 §11.1 cards_pre_sort', () => {
  it('sorts high to low', () => {
    const out = sortCardsByRank([card('5'), card('A'), card('K'), card('2')]);
    expect(out.map((c) => c.rank)).toEqual(['A', 'K', '5', '2']);
  });

  it('treats T and 10 as the same rank', () => {
    const out = sortCardsByRank([card('9'), card('T'), card('J')]);
    expect(out.map((c) => c.rank)).toEqual(['J', 'T', '9']);
  });

  it('does not mutate the hand it was given', () => {
    const hand = [card('2'), card('A')];
    const copy = [...hand];
    sortCardsByRank(hand);
    expect(hand).toEqual(copy);
  });

  it('handles an empty hand and a single card', () => {
    expect(sortCardsByRank([])).toEqual([]);
    expect(sortCardsByRank([card('7')]).map((c) => c.rank)).toEqual(['7']);
  });

  it('puts an unknown rank last rather than throwing', () => {
    const out = sortCardsByRank([card('??' as string), card('9')]);
    expect(out[out.length - 1].rank).toBe('??');
  });

  it('sorts a four-card Omaha hand', () => {
    const out = sortCardsByRank([card('7'), card('A'), card('Q'), card('3')]);
    expect(out.map((c) => c.rank)).toEqual(['A', 'Q', '7', '3']);
  });
});

describe('getGameVariantLabel', () => {
  it.each([
    ['nlh', "NO LIMIT HOLD'EM"],
    ['NLH', "NO LIMIT HOLD'EM"],
    ['plo4', 'POT LIMIT OMAHA (4)'],
    ['short_deck', 'SHORT DECK 6+'],
    ['SHORT_DECK', 'SHORT DECK 6+'],
  ])('labels %s', (input, expected) => {
    expect(getGameVariantLabel(input)).toBe(expected);
  });

  it('is case-insensitive across the whole table', () => {
    for (const key of Object.keys(GAME_VARIANT_LABELS)) {
      const other = key === key.toLowerCase() ? key.toUpperCase() : key.toLowerCase();
      if (other in GAME_VARIANT_LABELS) {
        expect(GAME_VARIANT_LABELS[other]).toBe(GAME_VARIANT_LABELS[key]);
      }
    }
  });

  it('falls back to a readable label for a variant it has never seen', () => {
    expect(getGameVariantLabel('some_new_game')).toBe('SOME NEW GAME');
  });

  it('never returns an empty label for a non-empty input', () => {
    for (const v of ['nlh', 'plo6', 'mystery_variant']) {
      expect(getGameVariantLabel(v).length).toBeGreaterThan(0);
    }
  });
});

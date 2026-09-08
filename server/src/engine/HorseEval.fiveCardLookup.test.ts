/**
 * The Omaha hot-path lookup must be the reference evaluator, only faster.
 * Exhaust every legal five-card deal: sampled poker math is how rare wheel,
 * double-pair and Short Deck ordering regressions reach production.
 */
import { describe, expect, it } from 'vitest';
import { scoreHoldem, scoreHoldemReference } from './HorseEval.js';
import { RANKS, SUITS } from './PokerEngine.js';
import type { Card } from '../types.js';

function deck(shortDeck: boolean): Card[] {
  const ranks = shortDeck ? RANKS.slice(4) : RANKS;
  const cards: Card[] = [];
  for (const rank of ranks) {
    for (const suit of SUITS) cards.push({ rank, suit } as Card);
  }
  return cards;
}

function assertEveryFiveCardDeal(shortDeck: boolean): number {
  const cards = deck(shortDeck);
  const hand: Card[] = new Array(5);
  let checked = 0;
  for (let a = 0; a < cards.length - 4; a++) {
    hand[0] = cards[a];
    for (let b = a + 1; b < cards.length - 3; b++) {
      hand[1] = cards[b];
      for (let c = b + 1; c < cards.length - 2; c++) {
        hand[2] = cards[c];
        for (let d = c + 1; d < cards.length - 1; d++) {
          hand[3] = cards[d];
          for (let e = d + 1; e < cards.length; e++) {
            hand[4] = cards[e];
            const lookup = scoreHoldem(hand, 5, shortDeck);
            const reference = scoreHoldemReference(hand, 5, shortDeck);
            if (lookup !== reference) {
              throw new Error(
                `five-card lookup diverged (${shortDeck ? 'short' : 'standard'}): ${hand
                  .map((card) => `${card.rank}:${card.suit}`)
                  .join(',')} lookup=${lookup} reference=${reference}`
              );
            }
            checked++;
          }
        }
      }
    }
  }
  return checked;
}

describe('five-card score lookup', () => {
  it('is identical for every standard-deck five-card deal', () => {
    expect(assertEveryFiveCardDeal(false)).toBe(2_598_960);
  });

  it('is identical for every Short Deck five-card deal', () => {
    expect(assertEveryFiveCardDeal(true)).toBe(376_992);
  });

  it('keeps the generic 6-8 card evaluator on its reference path', () => {
    const cards = deck(false).slice(0, 8);
    for (const count of [6, 7, 8]) {
      expect(scoreHoldem(cards, count, false)).toBe(scoreHoldemReference(cards, count, false));
    }
  });
});

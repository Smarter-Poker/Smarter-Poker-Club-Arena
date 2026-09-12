/** Offline independent high-hand reference for Phase 12.
 * No production scorer, rank table, shuffle or card-selection helper supplies
 * an answer. FLO8 retains the independent exact-two/exact-three Omaha oracle.
 */
import type { Card } from '../types.js';

export const REMAINING_REFERENCE_VERSION = 'remaining-variants-reference-round1-v1';
const RANKS = '23456789TJQKA';
const SUITS: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
export function remainingReferenceDeck(shortDeck = false): Card[] {
  return SUITS.flatMap((suit) =>
    [...(shortDeck ? RANKS.slice(4) : RANKS)].map((rank) => ({ rank: rank as Card['rank'], suit }))
  );
}
export function validateReferenceCards(cards: readonly Card[], shortDeck = false): void {
  const seen = new Set<string>();
  for (const card of cards) {
    if (
      !card ||
      !RANKS.includes(card.rank) ||
      card.rank.length !== 1 ||
      !SUITS.includes(card.suit) ||
      (shortDeck && RANKS.indexOf(card.rank) < 4)
    ) {
      throw new Error('Invalid physical card for this reference deck');
    }
    const key = card.rank + ':' + card.suit;
    if (seen.has(key)) throw new Error('Duplicate physical card');
    seen.add(key);
  }
}
export interface RemainingReferenceHand {
  category: number;
  kickers: number[];
  /** Independent base-15 lexicographic value, not the engine score encoding. */
  score: number;
}
export function referenceFiveHigh(
  cards: readonly Card[],
  shortDeck = false
): RemainingReferenceHand {
  if (cards.length !== 5) throw new Error('The reference requires exactly five cards');
  validateReferenceCards(cards, shortDeck);
  const values = cards.map((c) => RANKS.indexOf(c.rank) + 2).sort((a, b) => b - a);
  const groups = [...new Set(values)]
    .map((rank) => ({ rank, count: values.filter((v) => v === rank).length }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const straightTop =
    groups.length === 5
      ? values[0] - values[4] === 4
        ? values[0]
        : values.join(',') === (shortDeck ? '14,9,8,7,6' : '14,5,4,3,2')
          ? shortDeck
            ? 9
            : 5
          : 0
      : 0;
  const flush = cards.every((c) => c.suit === cards[0].suit);
  let category = 1,
    kickers = values;
  if (straightTop && flush) category = straightTop === 14 ? 10 : 9;
  else if (groups[0].count === 4) category = 8;
  else if (groups[0].count === 3 && groups[1].count === 2) category = shortDeck ? 6 : 7;
  else if (flush) category = shortDeck ? 7 : 6;
  else if (straightTop) category = 5;
  else if (groups[0].count === 3) category = 4;
  else if (groups[0].count === 2 && groups[1].count === 2) category = 3;
  else if (groups[0].count === 2) category = 2;
  if (straightTop && [5, 9, 10].includes(category)) {
    kickers = Array.from({ length: 5 }, (_, i) => straightTop - i);
    if (values[0] === 14 && straightTop !== 14) kickers[4] = 1;
  } else if ([2, 3, 4, 8, shortDeck ? 6 : 7].includes(category)) {
    kickers = groups.map((g) => g.rank);
  }
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);
  return { category, kickers, score };
}

/** Exactly two cards have survived the Pineapple discard. All five-card
 * subsets of the retained pair and public board are allowed, as in FLH/6+.
 */
export function referenceRemainingHigh(
  variant: 'short_deck' | 'pineapple' | 'flh',
  hole: Card[],
  board: Card[]
): RemainingReferenceHand {
  if (
    !['short_deck', 'pineapple', 'flh'].includes(variant) ||
    hole.length !== 2 ||
    board.length < 3 ||
    board.length > 5
  )
    throw new Error('Unsupported reference hand geometry');
  const all = [...hole, ...board],
    short = variant === 'short_deck';
  validateReferenceCards(all, short);
  let best: RemainingReferenceHand | null = null;
  for (let a = 0; a < all.length - 4; a++)
    for (let b = a + 1; b < all.length - 3; b++)
      for (let c = b + 1; c < all.length - 2; c++)
        for (let d = c + 1; d < all.length - 1; d++)
          for (let e = d + 1; e < all.length; e++) {
            const result = referenceFiveHigh([all[a], all[b], all[c], all[d], all[e]], short);
            if (!best || result.score > best.score) best = result;
          }
  return best!;
}

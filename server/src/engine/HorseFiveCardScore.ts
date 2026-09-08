import type { Card } from '../types.js';
import { RANK_VALUES } from './PokerEngine.js';

const topRank = (mask: number): number => 31 - Math.clz32(mask);

function topKickers(mask: number, count: number): number {
  let value = 0;
  while (count-- > 0) {
    const rank = topRank(mask);
    value = value * 16 + rank;
    mask ^= 1 << rank;
  }
  return value;
}

/**
 * Standard-deck, exactly-five-card high score, using HorseEval's encoding.
 * Omaha evaluates up to 150 such combinations per player per simulation.
 * Bit masks avoid clearing/counting scratch arrays and scanning all 13 ranks
 * on every combination. Short deck and best-five-of-seven use scoreHoldem.
 */
export function scoreFiveCards(cards: Card[]): number {
  let once = 0;
  let twice = 0;
  let thrice = 0;
  let four = 0;
  for (let i = 0; i < 5; i++) {
    const bit = 1 << RANK_VALUES[cards[i].rank];
    four |= thrice & bit;
    thrice |= twice & bit;
    twice |= once & bit;
    once |= bit;
  }
  const suit = cards[0].suit;
  const flush =
    cards[1].suit === suit &&
    cards[2].suit === suit &&
    cards[3].suit === suit &&
    cards[4].suit === suit;
  const runs = once & (once >> 1) & (once >> 2) & (once >> 3) & (once >> 4);
  const straight = runs ? topRank(runs) + 4 : (once & 0x403c) === 0x403c ? 5 : 0;

  if (flush && straight) return (straight === 14 ? 10 : 9) * 0x100000 + straight;
  if (four) return 8 * 0x100000 + topRank(four) * 16 + topRank(once ^ four);
  if (thrice && twice !== thrice) {
    return 7 * 0x100000 + topRank(thrice) * 16 + topRank(twice ^ thrice);
  }
  if (flush) return 6 * 0x100000 + topKickers(once, 5);
  if (straight) return 5 * 0x100000 + straight;
  if (thrice) return 4 * 0x100000 + topRank(thrice) * 256 + topKickers(once ^ thrice, 2);
  if (twice) {
    const highPair = topRank(twice);
    const otherPair = twice ^ (1 << highPair);
    if (otherPair) {
      return 3 * 0x100000 + highPair * 256 + topRank(otherPair) * 16 + topRank(once ^ twice);
    }
    return 2 * 0x100000 + highPair * 4096 + topKickers(once ^ twice, 3);
  }
  return 0x100000 + topKickers(once, 5);
}

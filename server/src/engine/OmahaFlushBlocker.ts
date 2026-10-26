import type { Card, CardRank, CardSuit } from '../types.js';
import { scoreOmahaHiPartial } from './HorseEval.js';

const ranks: CardRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const suits: CardSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
export interface OmahaFlushBlockerFact {
  status: 'invalid' | 'no_flush_threat' | 'available';
  suit: CardSuit | null;
  nutRank: CardRank | null;
  madeFlush: boolean;
  boardPaired: boolean;
  nutFlushPairs: number;
  survivingNutFlushPairs: number;
  bestSuitedScore: number;
  bestSuitedPairs: number;
  survivingBestSuitedPairs: number;
  straightFlushPossible: boolean;
  blocksNutFlush: boolean;
}

/** Public board and hero cards only. Enumerate real suited TWO-card pairs;
 * the existing high evaluator selects exactly THREE board cards. On ordinary
 * flush boards, a blocker must remove the whole highest-rank flush class:
 * king-only does not count while ace-X survives. If a straight flush is
 * possible, require removal of every physically best straight-flush pair.
 * Paired boards never grant an overall-nuts bluff credit for a flush blocker.
 */
export function omahaFlushBlocker(
  hole: readonly Card[],
  board: readonly Card[],
  holeCount: number
): OmahaFlushBlockerFact {
  const empty = (status: OmahaFlushBlockerFact['status']): OmahaFlushBlockerFact => ({
    status,
    suit: null,
    nutRank: null,
    madeFlush: false,
    boardPaired: false,
    nutFlushPairs: 0,
    survivingNutFlushPairs: 0,
    bestSuitedScore: 0,
    bestSuitedPairs: 0,
    survivingBestSuitedPairs: 0,
    straightFlushPossible: false,
    blocksNutFlush: false,
  });
  if (
    ![4, 5, 6].includes(holeCount) ||
    !Array.isArray(hole) ||
    hole.length !== holeCount ||
    !Array.isArray(board) ||
    board.length < 3 ||
    board.length > 5
  )
    return empty('invalid');
  const seen = new Set<string>();
  for (const card of [...hole, ...board]) {
    if (!card || !ranks.includes(card.rank) || !suits.includes(card.suit)) return empty('invalid');
    const key = card.rank + ':' + card.suit;
    if (seen.has(key)) return empty('invalid');
    seen.add(key);
  }
  const suit = suits.find((s) => board.filter((c) => c.suit === s).length >= 3);
  if (!suit) return empty('no_flush_threat');
  const boardRanks = new Set(board.filter((c) => c.suit === suit).map((c) => c.rank));
  const heroRanks = new Set(hole.filter((c) => c.suit === suit).map((c) => c.rank));
  const available = ranks.filter((rank) => !boardRanks.has(rank));
  const nutRank = available[available.length - 1];
  const boardPaired = new Set(board.map((c) => c.rank)).size !== board.length;
  let nutFlushPairs = 0,
    survivingNutFlushPairs = 0,
    bestSuitedScore = 0,
    bestSuitedPairs = 0,
    survivingBestSuitedPairs = 0;
  for (let a = 0; a < available.length; a++)
    for (let b = a + 1; b < available.length; b++) {
      const survives = !heroRanks.has(available[a]) && !heroRanks.has(available[b]);
      if (available[a] === nutRank || available[b] === nutRank) {
        nutFlushPairs++;
        if (survives) survivingNutFlushPairs++;
      }
      const score = scoreOmahaHiPartial(
        [
          { rank: available[a], suit },
          { rank: available[b], suit },
        ],
        [...board]
      );
      if (score > bestSuitedScore) {
        bestSuitedScore = score;
        bestSuitedPairs = 0;
        survivingBestSuitedPairs = 0;
      }
      if (score === bestSuitedScore) {
        bestSuitedPairs++;
        if (survives) survivingBestSuitedPairs++;
      }
    }
  const straightFlushPossible = Math.floor(bestSuitedScore / 0x100000) >= 9;
  const madeFlush = heroRanks.size >= 2;
  return {
    status: 'available',
    suit,
    nutRank,
    madeFlush,
    boardPaired,
    nutFlushPairs,
    survivingNutFlushPairs,
    bestSuitedScore,
    bestSuitedPairs,
    survivingBestSuitedPairs,
    straightFlushPossible,
    blocksNutFlush:
      !madeFlush &&
      !boardPaired &&
      (straightFlushPossible
        ? bestSuitedPairs > 0 && survivingBestSuitedPairs === 0
        : nutFlushPairs > 0 && survivingNutFlushPairs === 0),
  };
}

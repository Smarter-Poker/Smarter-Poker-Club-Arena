import { describe, expect, it } from 'vitest';
import { scoreOmahaHiPartial } from './HorseEval.js';
import { compareHands, evaluateOmahaHand, RANKS, SUITS } from './PokerEngine.js';
import type { Card } from '../types.js';

// Deliberately independent of HorseEval's RNG, lookup and combination loops.
function deal(seed: number): Card[] {
  const deck = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
  for (let i = deck.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

describe('horse Omaha ordering agrees with the independent settlement evaluator', () => {
  for (const holeCount of [4, 5, 6]) {
    for (const boardCount of [3, 4, 5]) {
      it(`${holeCount} hole cards, ${boardCount} board cards: physical deals and ties`, () => {
        for (let seed = 1; seed <= 128; seed++) {
          const deck = deal(seed + holeCount * 1000 + boardCount * 10000);
          const a = deck.slice(0, holeCount);
          const b = deck.slice(holeCount, holeCount * 2);
          const board = deck.slice(holeCount * 2, holeCount * 2 + boardCount);
          const fast = Math.sign(scoreOmahaHiPartial(a, board) - scoreOmahaHiPartial(b, board));
          const reference = Math.sign(
            compareHands(evaluateOmahaHand(a, board), evaluateOmahaHand(b, board))
          );
          expect(fast, `seed=${seed},holes=${holeCount},board=${boardCount}`).toBe(reference);
          expect(scoreOmahaHiPartial([...a].reverse(), [...board].reverse())).toBe(
            scoreOmahaHiPartial(a, board)
          );
        }
      });
    }
  }
});

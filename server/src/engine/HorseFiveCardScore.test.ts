import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { RANKS, SUITS } from './PokerEngine.js';
import { scoreHoldem, scoreOmahaHi, scoreOmahaHiPartial } from './HorseEval.js';
import { scoreFiveCards } from './HorseFiveCardScore.js';

const deck: Card[] = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));

describe('Omaha five-card evaluation preserves every ranking', () => {
  it('matches the general evaluator for all 2,598,960 distinct five-card hands', () => {
    const hand: Card[] = new Array(5);
    let checked = 0;
    for (let a = 0; a < 48; a++)
      for (let b = a + 1; b < 49; b++)
        for (let c = b + 1; c < 50; c++)
          for (let d = c + 1; d < 51; d++)
            for (let e = d + 1; e < 52; e++) {
              hand[0] = deck[a];
              hand[1] = deck[b];
              hand[2] = deck[c];
              hand[3] = deck[d];
              hand[4] = deck[e];
              const expected = scoreHoldem(hand, 5, false);
              const actual = scoreFiveCards(hand);
              if (actual !== expected) throw new Error(JSON.stringify({ hand, expected, actual }));
              checked++;
            }
    expect(checked).toBe(2_598_960);
  }, 30_000);

  it('keeps exactly two hole cards and three board cards for PLO4/5/6 on every street', () => {
    let seed = 72319;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (const holeCount of [4, 5, 6])
      for (const boardCount of [3, 4, 5]) {
        for (let sample = 0; sample < 100; sample++) {
          const indices = new Set<number>();
          while (indices.size < holeCount + boardCount) indices.add(random() % 52);
          const cards = [...indices].map((i) => deck[i]);
          const hole = cards.slice(0, holeCount),
            board = cards.slice(holeCount);
          let expected = 0;
          for (let a = 0; a < holeCount; a++)
            for (let b = a + 1; b < holeCount; b++)
              for (let x = 0; x < boardCount; x++)
                for (let y = x + 1; y < boardCount; y++)
                  for (let z = y + 1; z < boardCount; z++) {
                    expected = Math.max(
                      expected,
                      scoreHoldem([hole[a], hole[b], board[x], board[y], board[z]], 5, false)
                    );
                  }
          expect(scoreOmahaHiPartial(hole, board)).toBe(expected);
          if (boardCount === 5) expect(scoreOmahaHi(hole, board)).toBe(expected);
        }
      }
  });
});

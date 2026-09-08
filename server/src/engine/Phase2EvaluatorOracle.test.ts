import { describe, it, expect } from 'vitest';
import {
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
} from './PokerEngine.js';
import type { Card } from '../types.js';

// Independently constructed rank-count/bitmask oracle. No production evaluator,
// combination helper, rank table or shuffle is used to compute expected values.
// This is an internal differential test, not third-party certification.
const ranks = '23456789TJQKA';
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const pack: Card[] = suits.flatMap((suit) =>
  [...ranks].map((rank) => ({ rank: rank as Card['rank'], suit }))
);
function score(cards: Card[], short = false): number {
  const counts = Array(15).fill(0) as number[];
  let mask = 0;
  for (const c of cards) {
    const r = ranks.indexOf(c.rank) + 2;
    counts[r]++;
    mask |= 1 << r;
  }
  let straight = 0;
  for (let hi = 14; hi >= 6; hi--)
    if ((mask & (31 << (hi - 4))) === 31 << (hi - 4)) {
      straight = hi;
      break;
    }
  const wheel = short ? (1 << 14) | (15 << 6) : (1 << 14) | (15 << 2);
  if (!straight && (mask & wheel) === wheel) straight = short ? 9 : 5;
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const groups: number[][] = [[], [], [], [], []];
  for (let r = 14; r >= 2; r--) if (counts[r]) groups[counts[r]].push(r);
  let category = 1,
    key: number[] = [];
  if (flush && straight) {
    category = straight === 14 ? 10 : 9;
    key = [straight];
  } else if (groups[4].length) {
    category = 8;
    key = [...groups[4], ...groups[1]];
  } else if (groups[3].length && groups[2].length) {
    category = short ? 6 : 7;
    key = [...groups[3], ...groups[2]];
  } else if (flush) {
    category = short ? 7 : 6;
    key = [...groups[1]];
  } else if (straight) {
    category = 5;
    key = [straight];
  } else if (groups[3].length) {
    category = 4;
    key = [...groups[3], ...groups[1]];
  } else if (groups[2].length === 2) {
    category = 3;
    key = [...groups[2], ...groups[1]];
  } else if (groups[2].length) {
    category = 2;
    key = [...groups[2], ...groups[1]];
  } else key = groups[1];
  let value = category;
  for (let i = 0; i < 5; i++) value = value * 15 + (key[i] ?? 0);
  return value;
}
function best(hole: Card[], board: Card[], omaha: boolean, short: boolean): number {
  const cards = [...hole, ...board];
  let result = -1;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const indices = [a, b, c, d, e];
            if (omaha && indices.filter((i) => i < hole.length).length !== 2) continue;
            result = Math.max(
              result,
              score(
                indices.map((i) => cards[i]),
                short
              )
            );
          }
  return result;
}
let seed = 0x19283746;
function deal(n: number, short: boolean): Card[] {
  const available = short ? pack.filter((c) => ranks.indexOf(c.rank) >= 4) : [...pack];
  const result: Card[] = [];
  for (let i = 0; i < n; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    result.push(available.splice((seed >>> 0) % available.length, 1)[0]);
  }
  return result;
}

describe('phase2 independent evaluator differential corpus', () => {
  for (const [name, count, omaha, short] of [
    ['holdem', 2, false, false],
    ['short_deck', 2, false, true],
    ['omaha4', 4, true, false],
    ['omaha5', 5, true, false],
    ['omaha6', 6, true, false],
  ] as const) {
    it(`${name}: chosen cards, category and winner order agree with the oracle`, () => {
      for (let trial = 0; trial < 250; trial++) {
        const cards = deal(5 + count * 2, short),
          board = cards.slice(0, 5);
        const a = cards.slice(5, 5 + count),
          b = cards.slice(5 + count);
        const ea = omaha ? evaluateOmahaHand(a, board) : evaluateHand(a, board, short);
        const eb = omaha ? evaluateOmahaHand(b, board) : evaluateHand(b, board, short);
        const sa = best(a, board, omaha, short),
          sb = best(b, board, omaha, short);
        expect(score(ea.cards, short)).toBe(sa);
        expect(score(eb.cards, short)).toBe(sb);
        expect(ea.ranking).toBe(Math.floor(sa / 15 ** 5));
        expect(eb.ranking).toBe(Math.floor(sb / 15 ** 5));
        expect(Math.sign(compareHands(ea, eb))).toBe(Math.sign(sa - sb));
        if (omaha) {
          expect(ea.cards.filter((c) => a.includes(c))).toHaveLength(2);
          expect(eb.cards.filter((c) => b.includes(c))).toHaveLength(2);
        }
      }
    });
  }
});

function lowMask(cards: Card[]): number | null {
  let mask = 0;
  for (const c of cards) {
    const r = c.rank === 'A' ? 1 : ranks.indexOf(c.rank) + 2;
    if (r > 8 || mask & (1 << r)) return null;
    mask |= 1 << r;
  }
  return mask;
}
function bestLow(hole: Card[], board: Card[]): number | null {
  let result: number | null = null;
  for (let a = 0; a < hole.length - 1; a++)
    for (let b = a + 1; b < hole.length; b++)
      for (let c = 0; c < board.length - 2; c++)
        for (let d = c + 1; d < board.length - 1; d++)
          for (let e = d + 1; e < board.length; e++) {
            const value = lowMask([hole[a], hole[b], board[c], board[d], board[e]]);
            if (value !== null && (result === null || value < result)) result = value;
          }
  return result;
}
describe('Omaha eight-or-better low oracle', () => {
  it('qualification and ace-low ordering agree over 1000 distinct deals', () => {
    let qualified = 0;
    for (let trial = 0; trial < 1000; trial++) {
      const cards = deal(9, false),
        hole = cards.slice(0, 4),
        board = cards.slice(4);
      const expected = bestLow(hole, board),
        actual = evaluateOmahaLowHand(hole, board);
      if (expected === null) expect(actual).toBeNull();
      else {
        qualified++;
        expect(actual).not.toBeNull();
        expect(lowMask(actual!.cards)).toBe(expected);
        expect(actual!.cards.filter((c) => hole.includes(c))).toHaveLength(2);
        const expectedRanks: number[] = [];
        for (let rank = 8; rank >= 1; rank--) if (expected & (1 << rank)) expectedRanks.push(rank);
        expect(actual!.kickers).toEqual(expectedRanks);
      }
    }
    expect(qualified).toBeGreaterThan(0);
  });
});

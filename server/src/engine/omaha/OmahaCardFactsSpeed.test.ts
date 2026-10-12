import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../types.js';
import { omahaCardFacts } from './OmahaCardFacts.js';

const RANKS = '23456789TJQKA';
const SUITS: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const DECK: Card[] = SUITS.flatMap((suit) =>
  RANKS.split('').map((rank) => ({ rank: rank as Card['rank'], suit }))
);

describe('Omaha card facts: integer transitions', () => {
  // The digest is the facts of the previous (string-keyed, per-transition
  // re-filtering) implementation over these 40,000 deals: 4/5/6-card hands,
  // preflop/flop/turn/river boards, with and without transitions and low. The
  // faster implementation produced the same JSON on every deal (and on 20,000
  // suit- and low-heavy deals) before this digest was pinned; any change to a
  // fact on any deal moves it.
  it('reproduces the reference facts exactly over 40,000 random deals', () => {
    let state = 777;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const hash = createHash('sha256');
    for (let i = 0; i < 40_000; i++) {
      const deck = DECK.slice();
      const draw = () => deck.splice(Math.floor(random() * deck.length), 1)[0];
      const hole = Array.from({ length: 4 + (i % 3) }, draw);
      const board = Array.from({ length: [0, 3, 4, 5][Math.floor(i / 3) % 4] }, draw);
      hash.update(JSON.stringify(omahaCardFacts(hole, board, i % 7 !== 0, i % 5 !== 0)));
    }
    expect(hash.digest('hex')).toBe(
      '97c5861e9fe144fc9bd4c954a029cce9cd2a638b8c6af6d238a298e20ee5d763'
    );
  }, 60_000);
});

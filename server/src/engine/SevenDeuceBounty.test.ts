import { describe, it, expect } from 'vitest';
import {
  isSevenTwo,
  computeSevenDeuceBounties,
  type SevenDeucePlayerState,
} from './SevenDeuceBounty.js';

const P = (userId: string, ranks: string[], stack: number): SevenDeucePlayerState => ({
  userId,
  cards: ranks.map((rank) => ({ rank })),
  stack,
});

describe('isSevenTwo', () => {
  it('detects a 7 and a 2 (offsuit)', () => {
    expect(isSevenTwo([{ rank: '7' }, { rank: '2' }])).toBe(true);
  });
  it('detects a 7 and a 2 regardless of order or extra cards', () => {
    expect(isSevenTwo([{ rank: '2' }, { rank: '7' }])).toBe(true);
    expect(isSevenTwo([{ rank: '2' }, { rank: '7' }, { rank: 'A' }])).toBe(true);
  });
  it('rejects hands missing a 7 or a 2', () => {
    expect(isSevenTwo([{ rank: '7' }, { rank: '3' }])).toBe(false);
    expect(isSevenTwo([{ rank: 'A' }, { rank: '2' }])).toBe(false);
    expect(isSevenTwo([{ rank: 'K' }, { rank: 'Q' }])).toBe(false);
  });
  it('rejects empty / nullish', () => {
    expect(isSevenTwo([])).toBe(false);
    expect(isSevenTwo(undefined)).toBe(false);
    expect(isSevenTwo(null)).toBe(false);
  });
});

describe('computeSevenDeuceBounties', () => {
  it('collects the bounty from every other dealt-in player', () => {
    const winner = P('w', ['7', '2'], 500);
    const dealtIn = [winner, P('a', ['A', 'K'], 300), P('b', ['Q', 'J'], 300)];
    const t = computeSevenDeuceBounties(['w'], dealtIn, 4); // 2 BB @ BB=2 -> 4
    expect(t).toHaveLength(1);
    expect(t[0].winnerUserId).toBe('w');
    expect(t[0].totalCollected).toBe(8); // 4 from each of two payers
    expect(t[0].payers).toEqual([
      { userId: 'a', amount: 4 },
      { userId: 'b', amount: 4 },
    ]);
  });

  it('pays nothing when the winner does not hold 7-2', () => {
    const dealtIn = [P('w', ['A', 'A'], 500), P('a', ['7', '2'], 300)];
    expect(computeSevenDeuceBounties(['w'], dealtIn, 4)).toEqual([]);
  });

  it('caps each payer at their remaining stack - never mints chips', () => {
    const dealtIn = [
      P('w', ['7', '2'], 500),
      P('short', ['A', 'K'], 1.5), // can only pay 1.5 of the 4 bounty
      P('full', ['Q', 'J'], 300),
    ];
    const t = computeSevenDeuceBounties(['w'], dealtIn, 4);
    expect(t[0].totalCollected).toBe(5.5); // 1.5 + 4
    expect(t[0].payers).toEqual([
      { userId: 'short', amount: 1.5 },
      { userId: 'full', amount: 4 },
    ]);
  });

  it('skips busted (zero-stack) payers entirely', () => {
    const dealtIn = [P('w', ['7', '2'], 500), P('busted', ['A', 'K'], 0), P('ok', ['Q', 'J'], 300)];
    const t = computeSevenDeuceBounties(['w'], dealtIn, 4);
    expect(t[0].totalCollected).toBe(4);
    expect(t[0].payers).toEqual([{ userId: 'ok', amount: 4 }]);
  });

  it('conserves chips: total collected equals the sum debited from payers', () => {
    const dealtIn = [
      P('w', ['7', '2'], 100),
      P('a', ['A', 'K'], 2),
      P('b', ['Q', 'J'], 10),
      P('c', ['T', '9'], 4),
    ];
    const bounty = 4;
    const t = computeSevenDeuceBounties(['w'], dealtIn, bounty);
    const sumPayers = t[0].payers.reduce((s, p) => s + p.amount, 0);
    expect(sumPayers).toBe(t[0].totalCollected);
    expect(t[0].totalCollected).toBe(2 + 4 + 4); // a capped at 2, b & c pay full 4
  });

  it('returns empty when nothing can be collected (all others busted)', () => {
    const dealtIn = [P('w', ['7', '2'], 500), P('a', ['A', 'K'], 0)];
    expect(computeSevenDeuceBounties(['w'], dealtIn, 4)).toEqual([]);
  });

  it('returns empty for non-positive bounty', () => {
    const dealtIn = [P('w', ['7', '2'], 500), P('a', ['A', 'K'], 300)];
    expect(computeSevenDeuceBounties(['w'], dealtIn, 0)).toEqual([]);
  });

  it('handles a chop where two winners each hold 7-2 (independent snapshots)', () => {
    // Rare: both chop winners hold a 7 and a 2. Each collects from the others
    // against the same pre-transfer snapshot; the engine re-caps at apply time.
    const dealtIn = [P('w1', ['7', '2'], 500), P('w2', ['7', '2'], 500), P('a', ['A', 'K'], 300)];
    const t = computeSevenDeuceBounties(['w1', 'w2'], dealtIn, 4);
    expect(t).toHaveLength(2);
    // w1 collects from w2 and a; w2 collects from w1 and a.
    expect(t[0].totalCollected).toBe(8);
    expect(t[1].totalCollected).toBe(8);
  });
});

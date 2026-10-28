import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { computeEquity } from './equity/equityWorker.js';
import {
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  compareLowHands,
  RANKS,
  SUITS,
} from './PokerEngine.js';
const cards = (text: string): Card[] =>
  text
    .split(' ')
    .filter(Boolean)
    .map((s) => ({
      rank: s.slice(0, -1),
      suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as any)[s.at(-1)!],
    })) as Card[];

describe('exact all-in display equity', () => {
  it('finds the one backdoor royal runout even with a one-trial budget', () => {
    // Only Jh + Qh can beat quads. A 1000-trial sample may never draw it.
    const equities = computeEquity([cards('Ah Kh'), cards('2c 2s')], cards('2h 2d Th'), [], 1, {
      exact: true,
    });
    expect(equities[0]).toBeCloseTo(1 / 990, 12);
    expect(equities[0]).toBeGreaterThan(0);
    expect(equities[1]).toBeCloseTo(989 / 990, 12);
  });
  it('enumerates preflop Omaha through the cached triples without changing the exhaustive result', () => {
    // Independently retained full-board evaluation: 1,086,008 complete boards.
    expect(
      computeEquity([cards('Ah Ad 2h 3h'), cards('Kh Kd 4h 5h')], [], [], 1, {
        exact: true,
        omaha: true,
      })[0]
    ).toBeCloseTo(0.7011228278244728, 12);
  });
  it('splits a board-only three-way tie', () => {
    expect(
      computeEquity(
        [cards('2c 3c'), cards('4c 5c'), cards('6c 7c')],
        cards('Ah Kh Qh Jh Th'),
        [],
        1,
        { exact: true }
      )
    ).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
  it('awards the low half to a hand drawing dead for high', () => {
    expect(
      computeEquity([cards('As 2s Qc Jc'), cards('Kh Kd Qh Qd')], cards('3h 4d 8c Ks Kc'), [], 1, {
        exact: true,
        omaha: true,
        hiLo: true,
      })
    ).toEqual([0.5, 0.5]);
  });
  it('excludes exposed cards on another board', () => {
    const h = [cards('Ah Ad'), cards('Kh Kd')],
      b = cards('2s 3s 7c 9d');
    expect(computeEquity(h, b, cards('Kc Ks'), 1, { exact: true })).toEqual([1, 0]);
    expect(computeEquity(h, b, [], 1, { exact: true })[1]).toBeCloseTo(2 / 44, 12);
  });
  it('counts a side pot that the main-pot winner cannot win', () => {
    const result = computeEquity(
      [cards('Ah Ad'), cards('Kh Kd'), cards('Qh Qd')],
      cards('2s 3s 7c 9d Ac'),
      [],
      1,
      {
        exact: true,
        pots: [
          { amount: 30, eligible: [0, 1, 2] },
          { amount: 40, eligible: [1, 2] },
        ],
      }
    );
    expect(result[0]).toBe(1);
    expect(result[1]).toBeCloseTo(4 / 7, 12);
    expect(result[2]).toBe(0);
  });
  it('rejects duplicated cards, incomplete fields and impossible boards', () => {
    for (const [hands, board] of [
      [[cards('Ah Ad'), cards('Ah Kd')], cards('2s 3s 7c')],
      [[cards('Ah'), cards('Kh Kd')], []],
      [[cards('Ah Ad'), cards('Kh Kd')], cards('2s')],
    ] as [Card[][], Card[]][]) {
      expect(() => computeEquity(hands, board, [], 1, { exact: true })).toThrow();
    }
  });
  it.each(['nlh', 'short_deck', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8'])(
    'matches settlement on every river for %s',
    (variant) => {
      const omaha = variant.startsWith('plo') || variant === 'flo8',
        hiLo = variant === 'plo8' || variant === 'flo8',
        short = variant === 'short_deck';
      const n = variant === 'plo6' ? 6 : variant === 'plo5' ? 5 : 4;
      const hands = omaha
        ? [cards('As 2s Qc Jc 6d 7d').slice(0, n), cards('Kh Kd Qh Qd 6c 7c').slice(0, n)]
        : [cards('As Qc'), cards('Kh Kd')];
      if (short) hands[0] = cards('As Qc');
      const board = cards(short ? '6h 8d 9c Ts' : '3h 4d 8c Ks');
      const known = new Set([...hands.flat(), ...board].map((c) => c.rank + ':' + c.suit));
      const totals = [0, 0];
      let count = 0;
      for (const rank of RANKS)
        for (const suit of SUITS) {
          if ((short && ['2', '3', '4', '5'].includes(rank)) || known.has(rank + ':' + suit))
            continue;
          const full = board.concat({ rank, suit });
          const high = hands.map((h) =>
            omaha ? evaluateOmahaHand(h, full) : evaluateHand(h, full, short)
          );
          const cmp = compareHands(high[0], high[1]);
          const lows = hiLo ? hands.map((h) => evaluateOmahaLowHand(h, full)) : [];
          const lowExists = lows.some(Boolean);
          const share = lowExists ? 0.5 : 1;
          if (cmp >= 0) totals[0] += cmp === 0 ? share / 2 : share;
          if (cmp <= 0) totals[1] += cmp === 0 ? share / 2 : share;
          if (lowExists) {
            const lc = !lows[0]
              ? 1
              : !lows[1]
                ? -1
                : compareLowHands(lows[0]!.kickers, lows[1]!.kickers);
            if (lc <= 0) totals[0] += lc === 0 ? 0.25 : 0.5;
            if (lc >= 0) totals[1] += lc === 0 ? 0.25 : 0.5;
          }
          count++;
        }
      const actual = computeEquity(hands, board, [], 1, {
        exact: true,
        omaha,
        hiLo,
        shortDeck: short,
      });
      actual.forEach((p, i) => expect(p).toBeCloseTo(totals[i] / count, 12));
    }
  );
});

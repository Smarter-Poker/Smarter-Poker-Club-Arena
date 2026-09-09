import { describe, expect, it } from 'vitest';

import type { Card, CardRank, CardSuit } from '../../types.js';
import { computeLayeredEquity } from './equityWorker.js';

const card = (rank: CardRank, suit: CardSuit): Card => ({ rank, suit });

describe('layered all-in equity settlement oracle', () => {
  it('prices a short-stack main pot separately from the covering side pot', () => {
    const result = computeLayeredEquity(
      [
        [card('A', 'hearts'), card('5', 'hearts')],
        [card('K', 'spades'), card('K', 'diamonds')],
        [card('Q', 'spades'), card('Q', 'diamonds')],
      ],
      ['A', 'B', 'C'],
      [1, 2, 3],
      [[card('2', 'clubs'), card('3', 'diamonds'), card('4', 'hearts'), card('9', 'spades')]],
      [],
      1000,
      'nlh',
      [
        { potIndex: 0, amount: 150, eligiblePlayerIds: ['A', 'B', 'C'] },
        { potIndex: 1, amount: 100, eligiblePlayerIds: ['B', 'C'] },
      ],
      3,
      250,
      0.01,
      1
    );

    expect(result.exact).toBe(true);
    expect(result.runouts).toBe(42);
    expect(result.equities).toEqual([1, 0, 0]);
    expect(result.layerEquities[0]).toEqual([1, 0, 0]);
    expect(result.layerEquities[1][0]).toBe(0);
    expect(result.layerEquities[1][1]).toBeCloseTo(40 / 42, 12);
    expect(result.layerEquities[1][2]).toBeCloseTo(2 / 42, 12);
    expect(result.expectedNetReturns[0]).toBe(150);
    expect(result.expectedNetReturns[1]).toBeCloseTo(95.23809523809524, 12);
    expect(result.expectedNetReturns[2]).toBeCloseTo(4.761904761904762, 12);
    expect(result.expectedNetReturns.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(250, 12);
  });

  it('splits an odd-cent pot across complete boards before canonical awards', () => {
    const result = computeLayeredEquity(
      [
        [card('A', 'spades'), card('A', 'hearts')],
        [card('K', 'spades'), card('K', 'hearts')],
      ],
      ['A', 'B'],
      [2, 8],
      [
        [
          card('Q', 'clubs'),
          card('J', 'diamonds'),
          card('9', 'clubs'),
          card('4', 'diamonds'),
          card('2', 'clubs'),
        ],
        [
          card('K', 'diamonds'),
          card('Q', 'diamonds'),
          card('J', 'clubs'),
          card('8', 'diamonds'),
          card('3', 'clubs'),
        ],
      ],
      [],
      1000,
      'nlh',
      [{ potIndex: 0, amount: 0.03, eligiblePlayerIds: ['A', 'B'] }],
      5,
      0.03,
      0.01
    );

    expect(result).toMatchObject({ exact: true, runouts: 1, equities: [0.5, 0.5] });
    expect(result.expectedNetReturns).toEqual([0.02, 0.01]);
    expect(result.layerEquities[0][0]).toBeCloseTo(2 / 3, 12);
    expect(result.layerEquities[0][1]).toBeCloseTo(1 / 3, 12);
  });

  it('uses actual sparse seats for the canonical odd-chip winner', () => {
    const result = computeLayeredEquity(
      [
        [card('2', 'clubs'), card('3', 'diamonds')],
        [card('4', 'clubs'), card('5', 'diamonds')],
      ],
      ['seat-2', 'seat-8'],
      [2, 8],
      [
        [
          card('A', 'hearts'),
          card('K', 'hearts'),
          card('Q', 'hearts'),
          card('J', 'hearts'),
          card('T', 'hearts'),
        ],
      ],
      [],
      1000,
      'nlh',
      [{ potIndex: 0, amount: 0.03, eligiblePlayerIds: ['seat-2', 'seat-8'] }],
      5,
      0.03,
      0.01
    );

    expect(result.equities).toEqual([0.5, 0.5]);
    expect(result.expectedNetReturns).toEqual([0.01, 0.02]);
  });

  it('accepts three complete simultaneous boards as one globally unique universe', () => {
    const result = computeLayeredEquity(
      [
        [card('A', 'spades'), card('A', 'hearts')],
        [card('K', 'spades'), card('K', 'hearts')],
      ],
      ['A', 'B'],
      [1, 2],
      [
        [
          card('2', 'clubs'),
          card('3', 'clubs'),
          card('4', 'clubs'),
          card('5', 'clubs'),
          card('6', 'clubs'),
        ],
        [
          card('7', 'diamonds'),
          card('8', 'diamonds'),
          card('9', 'diamonds'),
          card('T', 'diamonds'),
          card('J', 'diamonds'),
        ],
        [
          card('Q', 'clubs'),
          card('K', 'clubs'),
          card('A', 'clubs'),
          card('2', 'diamonds'),
          card('3', 'diamonds'),
        ],
      ],
      [],
      1000,
      'nlh',
      [{ potIndex: 0, amount: 0.03, eligiblePlayerIds: ['A', 'B'] }],
      1,
      0.03,
      0.01
    );

    expect(result).toMatchObject({ exact: true, runouts: 1 });
    expect(result.expectedNetReturns.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(
      0.03,
      12
    );
  });
});

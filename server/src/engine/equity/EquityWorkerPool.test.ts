import { describe, it, expect, afterAll } from 'vitest';
import type { Card, CardRank, CardSuit } from '../../types.js';
import { EquityWorkerPool } from './EquityWorkerPool.js';
import { computeEquity } from './equityWorker.js';

const C = (rank: CardRank, suit: CardSuit): Card => ({ rank, suit });

const pool = new EquityWorkerPool();
afterAll(async () => {
  await pool.shutdown();
});

describe('EquityWorkerPool.estimateEquity', () => {
  it('AA vs KK preflop ~ 0.82 / 0.18', async () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = await pool.estimateEquity(hands, [], [], 20000);
    expect(eq).toHaveLength(2);
    expect(eq[0]).toBeGreaterThan(0.79);
    expect(eq[0]).toBeLessThan(0.86);
    expect(eq[1]).toBeGreaterThan(0.14);
    expect(eq[1]).toBeLessThan(0.21);
    expect(eq[0] + eq[1]).toBeCloseTo(1, 5);
  });

  it('is deterministic per (seed, inputs)', async () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('K', 'spades')],
      [C('Q', 'hearts'), C('Q', 'clubs')],
    ];
    const a = await pool.estimateEquity(hands, [], [], 5000, {}, 123);
    const b = await pool.estimateEquity(hands, [], [], 5000, {}, 123);
    expect(a).toEqual(b);
  });

  it('a made hand on a complete board reads 100% (single deterministic eval)', async () => {
    // Hero flopped a set of aces vs KK on a dry, fully dealt board.
    const board: Card[] = [
      C('A', 'clubs'),
      C('7', 'diamonds'),
      C('2', 'hearts'),
      C('9', 'spades'),
      C('3', 'clubs'),
    ];
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = await pool.estimateEquity(hands, board, [], 1000);
    expect(eq[0]).toBeCloseTo(1, 5);
    expect(eq[1]).toBeCloseTo(0, 5);
  });

  it('synchronous computeEquity matches the pool for the AA vs KK matchup', () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = computeEquity(hands, [], [], 20000, {}, 999);
    expect(eq[0]).toBeGreaterThan(0.79);
    expect(eq[0]).toBeLessThan(0.86);
  });
});

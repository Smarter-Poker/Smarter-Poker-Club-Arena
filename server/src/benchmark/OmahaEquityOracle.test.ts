import { describe, it, expect } from 'vitest';
import type { Card } from '../types.js';
import { evaluateOmahaEquity, type OmahaEquityRequest } from './OmahaEquityOracle.js';

const parse = (text: string): Card[] =>
  text.split(' ').map((s) => ({
    rank: s[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[
      s[1] as 'c' | 'd' | 'h' | 's'
    ],
  }));
const hero = parse('As 2s Jh Td'),
  high = parse('Kh Kd Qc Qd'),
  low = parse('Ah 2h 9s 9d'),
  neutral = parse('9c 9h 7s 7d');
function scenario(): OmahaEquityRequest {
  return {
    variant: 'plo8',
    heroId: 'hero',
    players: [
      { id: 'hero', seat: 1, contributed: 100, range: { combos: [{ cards: hero, weight: 1 }] } },
      {
        id: 'v1',
        seat: 2,
        contributed: 100,
        range: {
          combos: [
            { cards: high, weight: 3 },
            { cards: low, weight: 1 },
          ],
        },
      },
    ],
    boards: [parse('3c 4d 8h Kc Qh')],
    chipUnit: 0.01,
    dealerSeat: 1,
    mode: 'exact_river',
    samples: 256,
    seed: 901901,
  };
}
function withoutClock(result: Awaited<ReturnType<typeof evaluateOmahaEquity>>) {
  const { elapsedMs, ...rest } = result;
  return rest;
}

describe('Phase 9 bounded joint-deck Omaha equity', () => {
  it('enumerates weighted river shares, high/low and a quartered low exactly', async () => {
    const input = scenario(),
      before = JSON.stringify(input),
      result = await evaluateOmahaEquity(input);
    expect(result.complete).toBe(true);
    expect(result.samples).toBe(2);
    expect(result.equity).toBe(0.4375);
    expect(result.highEquity).toBe(0);
    expect(result.lowEquity).toBe(0.4375);
    expect(result.quarterOrLessProbability).toBe(0.25);
    expect(result.distribution).toEqual([
      { share: 0.25, probability: 0.25 },
      { share: 0.5, probability: 0.75 },
    ]);
    expect(result.confidence99).toEqual([0.4375, 0.4375]);
    expect(result.guaranteedShare).toBe(0.25);
    expect(result.expectedChips).toBe(87.5);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('conditions on dead cards and reports excluded combinations', async () => {
    const input = scenario();
    input.deadCards = parse('Kd');
    const result = await evaluateOmahaEquity(input);
    expect(result.excludedCombos).toBe(1);
    expect(result.equity).toBe(0.25);
  });
  it('rejects the whole colliding tuple, without sequential seat-order weighting', async () => {
    const input = scenario();
    input.players[1].range = {
      combos: [
        { cards: high, weight: 1 },
        { cards: low, weight: 1 },
      ],
    };
    input.players.push({
      id: 'v2',
      seat: 3,
      contributed: 100,
      range: {
        combos: [
          { cards: low, weight: 1 },
          { cards: neutral, weight: 1 },
        ],
      },
    });
    const exact = await evaluateOmahaEquity(input);
    expect(exact.attempts).toBe(4);
    expect(exact.samples).toBe(3);
    expect(exact.equity).toBeCloseTo(1 / 3, 12);
    input.mode = 'sampled';
    input.samples = 4096;
    const sampled = await evaluateOmahaEquity(input);
    expect(sampled.complete).toBe(true);
    expect(sampled.attempts).toBeGreaterThan(sampled.samples);
    expect(Math.abs(sampled.equity - 1 / 3)).toBeLessThan(0.012);
    input.players.reverse();
    const reordered = await evaluateOmahaEquity(input);
    expect(withoutClock(reordered)).toEqual(withoutClock(sampled));
  }, 30000);
  it('never calls sampled minima guarantees, even after observing only one outcome', async () => {
    const input = scenario();
    input.players[1].range = { combos: [{ cards: high, weight: 1 }] };
    input.mode = 'sampled';
    input.samples = 16;
    const result = await evaluateOmahaEquity(input);
    expect(result.equity).toBe(0.5);
    expect(result.guaranteedShare).toBeNull();
    expect(result.possibleFreeroll).toBeNull();
    expect(result.confidence99[0]).toBeLessThan(0.5);
    expect(result.confidence99[1]).toBeGreaterThan(0.5);
  });
  it('uses one physical deck across shared-flop runouts and exposes board covariance', async () => {
    const input = scenario();
    input.mode = 'sampled';
    input.samples = 128;
    input.boards = [parse('3c 4d 8h Kc'), parse('3c 4d 8h Qh')];
    input.sharedPrefixLength = 3;
    input.players[1].range = { uniform: true };
    const a = await evaluateOmahaEquity(input),
      b = await evaluateOmahaEquity(input);
    expect(a.complete).toBe(true);
    expect(withoutClock(a)).toEqual(withoutClock(b));
    expect(a.perBoard).toHaveLength(2);
    expect(a.maxConservationError).toBeLessThan(1e-6);
    expect(a.distribution.reduce((s, p) => s + p.probability, 0)).toBeCloseTo(1, 10);
    expect(a.highEquity + a.lowEquity).toBeCloseTo(a.equity, 10);
    expect(a.boardCovariance[0][1]).toBeCloseTo(a.boardCovariance[1][0], 12);
    expect(a.boardCovariance[0][0]).toBeGreaterThanOrEqual(-1e-12);
  });
  it('normalizes equity only over eligible pot layers and reports returned excess separately', async () => {
    const input = scenario();
    input.players[1].contributed = 200;
    input.players[1].range = { combos: [{ cards: high, weight: 1 }] };
    input.players.push({
      id: 'low',
      seat: 3,
      contributed: 250,
      range: { combos: [{ cards: low, weight: 1 }] },
    });
    const result = await evaluateOmahaEquity(input);
    expect(result.eligiblePot).toBe(300);
    expect(result.refunds.low).toBe(50);
    expect(result.equity).toBe(0.25);
    expect(result.expectedChips).toBe(75);
  });
  it('marks incompatible ranges and cancellation incomplete instead of inventing a result', async () => {
    const input = scenario();
    input.players[1].range = { combos: [{ cards: hero, weight: 1 }] };
    const none = await evaluateOmahaEquity(input);
    expect(none.complete).toBe(false);
    expect(none.reason).toBe('incompatible_ranges');
    expect(none.samples).toBe(0);
    expect(none.confidence99).toEqual([0, 1]);
    const cancelled = await evaluateOmahaEquity(scenario(), () => false);
    expect(cancelled.complete).toBe(false);
    expect(cancelled.reason).toBe('cancelled');
    expect(cancelled.guaranteedShare).toBeNull();
  });
  it('rejects invalid cards, unknown variants, unbounded work and impossible decks', async () => {
    const duplicate = scenario();
    duplicate.deadCards = duplicate.boards[0].slice(0, 1);
    await expect(evaluateOmahaEquity(duplicate)).rejects.toThrow('Duplicate');
    const unknown = scenario();
    unknown.variant = 'nlh' as 'plo4';
    await expect(evaluateOmahaEquity(unknown)).rejects.toThrow('Unsupported');
    const tooMany = scenario();
    tooMany.samples = 4097;
    await expect(evaluateOmahaEquity(tooMany)).rejects.toThrow('budget');
    const incomplete = scenario();
    incomplete.boards[0].pop();
    await expect(evaluateOmahaEquity(incomplete)).rejects.toThrow('Exact river');
    const impossible = scenario();
    impossible.variant = 'plo6';
    impossible.mode = 'sampled';
    impossible.players = Array.from({ length: 8 }, (_, i) => ({
      id: i === 0 ? 'hero' : 'v' + i,
      seat: i + 1,
      contributed: 100,
      range: { uniform: true },
    }));
    impossible.boards = [[], [], []];
    await expect(evaluateOmahaEquity(impossible)).rejects.toThrow('shared deck');
  });
  it('rejects range weights that would silently lose positive probability', async () => {
    const input = scenario();
    input.players[1].range = {
      combos: [
        { cards: high, weight: 1e9 },
        { cards: low, weight: Number.MIN_VALUE },
      ],
    };
    await expect(evaluateOmahaEquity(input)).rejects.toThrow('weight precision');
  });
  it('treats player identifiers as data even when they name object properties', async () => {
    const input = scenario();
    input.heroId = '__proto__';
    input.players[0].id = '__proto__';
    const result = await evaluateOmahaEquity(input);
    expect(result.expectedChips).toBe(87.5);
    input.players[0].contributed = 150;
    const withRefund = await evaluateOmahaEquity(input);
    expect(withRefund.refunds.__proto__).toBe(50);
    expect(withRefund.expectedChips).toBe(137.5);
  });
});

/**
 * CHIP RACE — the lottery must actually be a lottery (A9, 2026-08-20).
 *
 * The lottery value was `fractionalChips * 1000 + secureRandomInt(1000)`. The
 * deterministic term dominates the random one by construction, so a player with
 * 500 fractional chips scored 500,000-500,999 and one with 499 scored
 * 499,000-499,999 — the larger holding ALWAYS won, and chance only ever broke
 * ties between identical fractions. That is a ranking, not a race.
 *
 * These tests pin the two things that matter: chip conservation (a race must
 * never mint or destroy tournament chips) and genuine probabilistic fairness
 * (more fractional chips means better odds, never certainty).
 */
import { describe, it, expect } from 'vitest';
import { ChipRaceEngine } from './ChipRaceEngine.js';

function race(stacks: Record<string, number>, oldDenom: number, newDenom: number) {
  const engine = new ChipRaceEngine();
  const map = new Map(Object.entries(stacks));
  const result = engine.executeChipRace('t1', map, oldDenom, newDenom);
  return { result, after: map };
}

function sum(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

describe('ChipRaceEngine - conservation', () => {
  it('never awards more chips than were collected', () => {
    for (let i = 0; i < 50; i++) {
      const { result } = race({ a: 5300, b: 4700, c: 2500, d: 1100 }, 25, 100);
      expect(result.totalNewChipsDistributed * 100).toBeLessThanOrEqual(
        result.totalFractionalCollected
      );
      const awarded = result.players.reduce((s, p) => s + p.chipsAwarded, 0);
      expect(awarded).toBe(result.totalNewChipsDistributed * 100);
    }
  });

  it('leaves every surviving stack on the new denomination', () => {
    const { after } = race({ a: 5300, b: 4700, c: 2500 }, 25, 100);
    for (const stack of after.values()) {
      expect(stack % 100).toBe(0);
      expect(stack).toBeGreaterThan(0);
    }
  });

  it('never zeroes a player out', () => {
    // A stack smaller than the new denomination must still survive the race.
    const { after } = race({ a: 5000, shorty: 40 }, 25, 100);
    expect(after.get('shorty')!).toBeGreaterThanOrEqual(100);
  });

  it('rejects a race that does not raise the denomination', () => {
    const engine = new ChipRaceEngine();
    expect(() => engine.executeChipRace('t1', new Map([['a', 100]]), 100, 25)).toThrow();
    expect(() => engine.executeChipRace('t1', new Map(), 25, 100)).toThrow();
  });
});

describe('ChipRaceEngine - THE A9 BUG: the race is probabilistic, not a ranking', () => {
  it('a smaller fractional holding can still win', () => {
    // 99 vs 1 fractional chips, one chip to award. Under the old formula the
    // 99-holder won 100% of the time; a real race gives the 1-holder ~1%.
    let underdogWins = 0;
    /* RUNS is a false-failure budget, not a taste.
     *
     * The underdog's odds here are exactly 1 in 100 (99 fractional chips vs 1,
     * one chip to award), so P(zero wins) = 0.99^RUNS. At RUNS = 400 that is
     * 1.8% — this test failed the whole Server Engine job on a healthy engine
     * on 2026-08-20 (run 32405597982), and would do so again roughly every
     * 55th push. A blocking test that cries wolf twice a month is how people
     * learn to re-run CI instead of reading it.
     *
     * At 3000 it is 8.7e-14, and the races are free: all eight tests in this
     * file execute in 10ms.
     */
    const RUNS = 3000;
    for (let i = 0; i < RUNS; i++) {
      const { result } = race({ big: 199, small: 101 }, 1, 100);
      const small = result.players.find((p) => p.playerId === 'small')!;
      if (small.chipsAwarded > 0) underdogWins++;
    }
    // Any win at all disproves the deterministic ranking. Bounded above so a
    // uniform-random (unweighted) implementation would also fail this: it would
    // hand the underdog ~50% where the weighted lottery gives ~1%.
    expect(underdogWins).toBeGreaterThan(0);
    expect(underdogWins).toBeLessThan(RUNS * 0.25);
  });

  it('the larger fractional holding still wins far more often', () => {
    let bigWins = 0;
    const RUNS = 300;
    for (let i = 0; i < RUNS; i++) {
      const { result } = race({ big: 190, small: 110 }, 1, 100);
      const big = result.players.find((p) => p.playerId === 'big')!;
      if (big.chipsAwarded > 0) bigWins++;
    }
    // 90 fractional chips vs 10 — the odds should be lopsided, just not absolute.
    expect(bigWins).toBeGreaterThan(RUNS * 0.6);
  });

  it('equal fractional holdings are a coin flip, not a fixed order', () => {
    let firstWins = 0;
    const RUNS = 300;
    for (let i = 0; i < RUNS; i++) {
      const { result } = race({ p1: 150, p2: 150 }, 1, 100);
      const p1 = result.players.find((p) => p.playerId === 'p1')!;
      if (p1.chipsAwarded > 0) firstWins++;
    }
    expect(firstWins).toBeGreaterThan(RUNS * 0.3);
    expect(firstWins).toBeLessThan(RUNS * 0.7);
  });

  it('a player with no fractional chips never wins a race chip', () => {
    for (let i = 0; i < 40; i++) {
      const { result } = race({ exact: 200, frac: 150 }, 1, 100);
      const exact = result.players.find((p) => p.playerId === 'exact')!;
      expect(exact.fractionalChips).toBe(0);
      expect(exact.chipsAwarded).toBe(0);
    }
  });
});

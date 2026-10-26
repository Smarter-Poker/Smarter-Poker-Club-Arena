import { describe, expect, it, vi } from 'vitest';
import { createIcmEquityEstimator, exactIcmEquity, icmEquityEstimate } from './IcmModel.js';

describe('winner-take-all ICM uses exact first-place probability', () => {
  it('agrees with an independent full finishing-rank MH distribution for two through ten seats', () => {
    for (let count = 2; count <= 10; count++) {
      const stacks = Array.from({ length: count }, (_, i) => 31 + i * i * 13);
      for (let hero = 0; hero < count; hero++) {
        const memo = new Map<number, number[]>();
        const ranks = (mask: number): number[] => {
          const prior = memo.get(mask);
          if (prior) return prior;
          const seats = stacks.map((_, i) => i).filter((i) => mask & (1 << i));
          const total = seats.reduce((sum, i) => sum + stacks[i], 0);
          const result = Array(count).fill(0) as number[];
          for (const winner of seats) {
            const probability = stacks[winner] / total;
            if (winner === hero) result[0] += probability;
            else if (mask & (1 << hero)) {
              ranks(mask & ~(1 << winner)).forEach((value, rank) => {
                if (rank + 1 < count) result[rank + 1] += probability * value;
              });
            }
          }
          memo.set(mask, result);
          return result;
        };
        const distribution = ranks((1 << count) - 1);
        expect(distribution.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 12);
        expect(exactIcmEquity(stacks, [137, ...Array(count - 1).fill(0)], hero)).toBeCloseTo(
          distribution[0] * 137,
          12
        );
      }
    }
  });

  it.each([2, 3, 10, 11, 18, 200, 1000])(
    'prices all %i entrants without sampling clocks or an artificial uncertainty radius',
    (count) => {
      const stacks = Array.from({ length: count }, (_, i) => 100 + i * 7);
      const total = stacks.reduce((sum, chips) => sum + chips, 0);
      const hero = count - 1;
      const log = vi.spyOn(Math, 'log');
      try {
        const workspace = createIcmEquityEstimator(stacks, [100], hero, [0, hero], 128);
        const expected = (stacks[hero] / total) * 100;
        expect(workspace.method).toBe('exact_mh');
        expect(workspace.trials).toBe(0);
        expect(workspace.randomClockDraws).toBe(0);
        expect(workspace.estimate(stacks)).toEqual({
          equity: expected,
          errorBound: 0,
          method: 'exact_mh',
          modeledPlayers: count,
        });
        expect(workspace.estimate(stacks, 1)).toEqual(workspace.estimate(stacks, 10000));
        expect(exactIcmEquity(stacks, [100], hero)).toBe(expected);
        expect(icmEquityEstimate(stacks, [100], hero)).toEqual(workspace.estimate(stacks));
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    }
  );

  it('retains every seat through bust and revival, and rejects immutable-field drift', () => {
    const reference = Array.from({ length: 10 }, () => 100).concat(0);
    const workspace = createIcmEquityEstimator(reference, [100], 0, [0, 10], 128);
    const restored = reference.slice();
    restored[0] = 50;
    restored[10] = 50;
    Object.freeze(restored);
    expect(workspace.estimate(restored)).toMatchObject({
      equity: 5,
      modeledPlayers: 11,
      errorBound: 0,
    });
    const busted = restored.slice();
    busted[0] = 0;
    busted[10] = 100;
    expect(workspace.estimate(busted)).toMatchObject({ equity: 0, modeledPlayers: 10 });
    expect(workspace.estimate(reference)).toMatchObject({ equity: 10, modeledPlayers: 10 });
    const drifted = restored.slice();
    drifted[1] += 1;
    expect(() => workspace.estimate(drifted)).toThrow('ICM remote stack changed');
    expect(() => workspace.estimate(restored.slice(1))).toThrow('ICM candidate vector length');
  });

  it('owns admitted inputs and each returned result, including reentrant candidate getters', () => {
    const stacks = [100, 200, 300];
    const prizes = [100, 0, 0];
    const mutable = [0, 1];
    const workspace = createIcmEquityEstimator(stacks, prizes, 0, mutable);
    stacks.fill(1);
    prizes.fill(1);
    mutable.fill(2);
    const nested = [50, 250, 300];
    let nestedEquity: number | undefined;
    const outer = [100, 200, 300];
    Object.defineProperty(outer, 0, {
      get() {
        nestedEquity = workspace.estimate(nested).equity;
        return 100;
      },
    });
    const result = workspace.estimate(outer);
    expect(result.equity).toBe((100 / 600) * 100);
    expect(nestedEquity).toBe((50 / 600) * 100);
    result.equity = -1;
    result.errorBound = -1;
    expect(workspace.estimate([100, 200, 300])).toMatchObject({
      equity: (100 / 600) * 100,
      errorBound: 0,
    });
  });

  it('uses the existing sanitization without confusing a later paid place with first place', () => {
    const reference = Array.from({ length: 18 }, () => 100);
    const workspace = createIcmEquityEstimator(reference, [100, 0, NaN, -1], 0, [0, 1]);
    for (const malformed of [NaN, Infinity, -1, 0]) {
      const vector = reference.slice();
      vector[0] = malformed;
      expect(workspace.estimate(vector)).toMatchObject({
        equity: 0,
        errorBound: 0,
        modeledPlayers: 17,
      });
    }
    for (const prizes of [
      [60, 40],
      [0, 100],
      [100, 0.01],
    ]) {
      const other = createIcmEquityEstimator(reference, prizes, 0, [0, 1], 128);
      expect(other.method).toBe('plackett_luce_mc');
      expect(other.trials).toBe(128);
      expect(other.estimate(reference).errorBound).toBeGreaterThan(0);
    }
    for (const hero of [-1, 0.5, 18]) expect(exactIcmEquity(reference, [100], hero)).toBe(0);
  });
});

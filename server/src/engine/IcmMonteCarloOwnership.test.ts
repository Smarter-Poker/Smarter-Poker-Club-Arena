import { describe, expect, it, vi } from 'vitest';
import { createIcmEquityEstimator, type IcmEstimate } from './IcmModel.js';

/** Independent full-field rank scan: no sorted remote workspace, active-slot
 * filter, binary search, paid-rank early stop or cached confidence expression. */
function fullRankReference(
  reference: number[],
  vector: number[],
  prizes: number[],
  hero: number,
  mutable: number[],
  trials = 128
): IcmEstimate {
  const local = new Set(mutable);
  const modeledPlayers = reference.filter((stack, index) =>
    local.has(index) ? Number.isFinite(vector[index]) && vector[index] > 0 : stack > 0
  ).length;
  if (!(Number.isFinite(vector[hero]) && vector[hero] > 0))
    return {
      equity: 0,
      errorBound: 0,
      method: 'plackett_luce_mc',
      modeledPlayers,
      trials,
      standardError: 0,
    };
  let seed =
    0x9e3779b9 ^
    ((hero + 1) * 0x85ebca6b) ^
    (reference.length * 0xc2b2ae35) ^
    (prizes.length << 16);
  const random = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return Math.max(Number.EPSILON, seed / 0x1_0000_0000);
  };
  let mean = 0,
    m2 = 0;
  for (let trial = 0; trial < trials; trial++) {
    const clocks = reference.map((stack, index) => {
      if (stack <= 0 && !local.has(index)) return Infinity;
      const draw = -Math.log(random());
      const rate = local.has(index) ? vector[index] : stack;
      return Number.isFinite(rate) && rate > 0 ? draw / rate : Infinity;
    });
    let rank = 0;
    for (let index = 0; index < clocks.length; index++)
      if (index !== hero && clocks[index] < clocks[hero]) rank++;
    const value = prizes[rank] ?? 0;
    const delta = value - mean;
    mean += delta / (trial + 1);
    m2 += delta * (value - mean);
  }
  return {
    equity: mean,
    errorBound: Math.max(...prizes) * Math.sqrt(Math.log(2 / 0.001) / (2 * trials)),
    method: 'plackett_luce_mc',
    modeledPlayers,
    trials,
    standardError: Math.sqrt(Math.max(0, m2 / (trials - 1)) / trials),
  };
}

describe('MC invocation ownership and invariant work', () => {
  it.each([
    [11, 2],
    [18, 6],
    [1000, 10],
  ])(
    'matches full-field ranks across %i players and %i mutable seats, including bust and revival',
    (field, count) => {
      const reference = Array.from({ length: field }, (_, i) => 100 + i * 3).concat(0);
      const mutable = Array.from({ length: count }, (_, i) =>
        Math.floor((i * (field - 1)) / (count - 1))
      );
      for (const hero of new Set([mutable[0], mutable[Math.floor(count / 2)], mutable.at(-1)!])) {
        const prizes = [50, 0, 30, 0, 20];
        const ws = createIcmEquityEstimator(reference, prizes, hero, mutable.slice().reverse());
        for (const malformed of [null, 0, NaN, Infinity, -1, 83.75]) {
          const vector = reference.slice();
          if (malformed !== null)
            for (const index of mutable) if (index !== hero) vector[index] = malformed;
          expect(ws.estimate(vector, 128)).toEqual(
            fullRankReference(reference, vector, prizes, hero, mutable)
          );
        }
        const busted = reference.slice();
        busted[hero] = 0;
        expect(ws.estimate(busted, 96)).toEqual(
          fullRankReference(reference, busted, prizes, hero, mutable, 96)
        );
        expect(ws.estimate(reference, 128)).toEqual(
          fullRankReference(reference, reference, prizes, hero, mutable)
        );
        expect(ws.randomClockDraws).toBe(ws.trials * field);
      }
    }
  );

  it.each(['local', 'remote'] as const)(
    'keeps %s getter reentrancy isolated from the outer active slots',
    (position) => {
      const reference = Array.from({ length: 18 }, (_, i) => 100 + i * 10);
      const prizes = [50, 0, 30, 20],
        mutable = [0, 2, 4, 8, 12, 17],
        hero = 4;
      const ws = createIcmEquityEstimator(reference, prizes, hero, mutable);
      const nestedVector = reference.slice();
      nestedVector[0] = 0;
      nestedVector[hero] += 100;
      const vector = reference.slice();
      const hook = position === 'local' ? 0 : 1;
      let nested: IcmEstimate | undefined,
        entered = false;
      Object.defineProperty(vector, hook, {
        get() {
          if (!entered) {
            entered = true;
            nested = ws.estimate(nestedVector, 128);
          }
          return reference[hook];
        },
      });
      expect(ws.estimate(vector, 96)).toEqual(
        fullRankReference(reference, reference, prizes, hero, mutable, 96)
      );
      expect(nested).toEqual(fullRankReference(reference, nestedVector, prizes, hero, mutable));
      expect(ws.estimate(reference, 128)).toEqual(
        fullRankReference(reference, reference, prizes, hero, mutable)
      );
      const drift = reference.slice();
      drift[1] += 0.01;
      expect(() => ws.estimate(drift, 128)).toThrow('ICM remote stack changed');
    }
  );

  it('owns admitted inputs and returned estimates, caching only each invariant prefix scalar', () => {
    const stacks = Array.from({ length: 18 }, (_, i) => 123 + i * 19);
    const reference = stacks.slice(),
      prizes = [50, 30, 20],
      mutable = [0, 1, 2, 3, 4, 5];
    const ws = createIcmEquityEstimator(stacks, prizes, 2, mutable);
    const expected = fullRankReference(reference, reference, prizes, 2, mutable);
    const expected96 = fullRankReference(reference, reference, prizes, 2, mutable, 96);
    stacks.fill(0);
    prizes.fill(0);
    mutable.fill(17);
    const log = vi.spyOn(Math, 'log');
    try {
      for (let i = 0; i < 64; i++) {
        const estimate = ws.estimate(reference, 128);
        expect(estimate).toEqual(expected);
        estimate.equity = -123;
        estimate.errorBound = -321;
      }
      // The original implementation repeats this exact same bound 64 times.
      // No random clocks may be regenerated during any candidate estimate.
      expect(log).toHaveBeenCalledTimes(1);
      expect(ws.estimate(reference, 0)).toEqual(expected96);
      expect(ws.estimate(reference, 96)).toEqual(expected96);
      expect(log).toHaveBeenCalledTimes(2);
      expect(ws.estimate(reference, NaN).trials).toBe(ws.trials);
      expect(ws.estimate(reference, Infinity).trials).toBe(ws.trials);
      expect(log).toHaveBeenCalledTimes(2);
      expect(ws.randomClockDraws).toBe(1200 * 18);
    } finally {
      log.mockRestore();
    }
  });
});

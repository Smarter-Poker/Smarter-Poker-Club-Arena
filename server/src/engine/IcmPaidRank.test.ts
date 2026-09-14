import { describe, expect, it } from 'vitest';
import { createIcmEquityEstimator } from './IcmModel.js';

/** Full-field rank scan: no sorted clocks, binary search or unpaid-rank cutoff. */
function fullRankReference(reference: number[], candidate: number[], prizes: number[]) {
  const hero = 1;
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
  let mean = 0;
  let m2 = 0;
  let unpaidTrials = 0;
  for (let trial = 0; trial < 128; trial++) {
    const clocks = reference.map((stack, index) => {
      const exponential = -Math.log(random());
      const rate = index < 3 ? candidate[index] : stack;
      return rate > 0 ? exponential / rate : Infinity;
    });
    let rank = 0;
    for (let index = 0; index < clocks.length; index++) {
      if (index !== hero && clocks[index] < clocks[hero]) rank++;
    }
    const value = candidate[hero] > 0 ? (prizes[rank] ?? 0) : 0;
    if (rank >= prizes.length) unpaidTrials++;
    const delta = value - mean;
    mean += delta / (trial + 1);
    m2 += delta * (value - mean);
  }
  return { mean, standardError: Math.sqrt(Math.max(0, m2 / 127) / 128), unpaidTrials };
}

describe('ICM paid-rank search preserves every trial payout', () => {
  it.each([18, 200, 1000])('matches full-field ranks for %i players', (count) => {
    const reference = Array.from({ length: count }, (_, i) => 200 + i * 3);
    reference[0] = 5000;
    reference[1] = 10000;
    const curves = [
      [50, 30, 20],
      [50, 0, 30, 0, 20],
      Array.from({ length: count }, (_, i) => count - i),
    ];
    for (const prizes of curves) {
      const estimator = createIcmEquityEstimator(reference, prizes, 1, [2, 1, 0], 128);
      for (const transfer of [-4000, 0, 4000]) {
        const candidate = reference.slice();
        candidate[0] += transfer;
        candidate[1] -= transfer;
        const expected = fullRankReference(reference, candidate, prizes);
        const actual = estimator.estimate(candidate);
        expect(actual.equity).toBe(expected.mean);
        expect(actual.standardError).toBe(expected.standardError);
        expect(actual.trials).toBe(128);
        expect(actual.modeledPlayers).toBe(count);
        expect(estimator.randomClockDraws).toBe(128 * count);
        if (count >= 200 && prizes.length < count) expect(expected.unpaidTrials).toBeGreaterThan(0);
      }
    }
  });
});

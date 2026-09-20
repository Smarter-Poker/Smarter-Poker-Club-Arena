import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIcmEquityEstimator, exactIcmEquity } from './IcmModel.js';

/** Independent finishing-order enumeration, without bitmask memoization. */
function reference(stacks: number[], payouts: number[], hero: number): number {
  const live = stacks
    .map((stack, index) => ({ stack: Number.isFinite(stack) && stack > 0 ? stack : 0, index }))
    .filter((entry) => entry.stack > 0);
  const prizes = payouts.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  if (live.length > 10 || !live.some((entry) => entry.index === hero)) return 0;
  function at(entries: typeof live, place: number): number {
    if (place >= prizes.length) return 0;
    const total = entries.reduce((sum, entry) => sum + entry.stack, 0);
    let value = 0;
    for (const entry of entries)
      value +=
        (entry.stack / total) *
        (entry.index === hero
          ? prizes[place]
          : at(
              entries.filter((other) => other !== entry),
              place + 1
            ));
    return value;
  }
  return at(live, 0);
}
afterEach(() => vi.unstubAllGlobals());

describe('exact ICM action workspace owns and reuses scratch', () => {
  it.each([2, 3, 6, 10])(
    'matches independent finishing orders for %i live seats through bust/revival and input sanitization',
    (count) => {
      const stacks = Array.from({ length: count }, (_, index) => 100 + index * 37).concat([0, 0]);
      for (const payouts of [[50, 30, 20], [50, 0, 30, 0, 20], [100]]) {
        const workspace = createIcmEquityEstimator(stacks, payouts, 1);
        for (let sample = 0; sample < 24; sample++) {
          const vector = stacks.slice();
          vector[0] = sample % 3 === 0 ? 0 : 100 + sample;
          vector[1] = sample % 5 === 0 ? 0 : 137 + sample * 11;
          if (sample % 7 === 0) vector[0] = Number.NaN;
          const expected = reference(vector, payouts, 1);
          expect(exactIcmEquity(vector, payouts, 1)).toBe(expected);
          expect(workspace.estimate(vector).equity).toBe(expected);
          expect(workspace.estimate(vector).errorBound).toBe(0);
        }
        expect(workspace.estimate(stacks).equity).toBe(reference(stacks, payouts, 1));
      }
    }
  );

  it('allocates one exact memo buffer per admitted workspace and none per repeated vector', () => {
    const Original = globalThis.Float64Array;
    const sizes: number[] = [];
    vi.stubGlobal(
      'Float64Array',
      new Proxy(Original, {
        construct(target, args) {
          sizes.push(Number(args[0]));
          return Reflect.construct(target, args, target);
        },
      })
    );
    const stacks = [300, 200, 100];
    const workspace = createIcmEquityEstimator(stacks, [65, 35], 0);
    expect(sizes).toEqual([1024]);
    for (let index = 0; index < 64; index++) {
      const vector = [300 - index, 200 + index, index % 2 ? 0 : 100];
      expect(workspace.estimate(vector).equity).toBe(reference(vector, [65, 35], 0));
    }
    expect(sizes).toEqual([1024]);
  });
});

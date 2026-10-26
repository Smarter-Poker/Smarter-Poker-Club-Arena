import type { Card } from '../types.js';
import { it, expect } from 'vitest';
import { variantInfo, seedFastRandom, fastRandom } from './HorseEval.js';
const suits: Record<string, Card['suit']> = { d: 'diamonds', c: 'clubs', h: 'hearts', s: 'spades' };
const cards = (s: string): Card[] =>
  s.split(' ').map((s) => ({ rank: s[0] as Card['rank'], suit: suits[s[1]] }));
it('scores paired made ranges on legal chronological boards without consuming decision RNG', () => {
  for (const variant of ['plo4', 'plo5', 'plo6']) {
    seedFastRandom(123);
    const expected = fastRandom();
    seedFastRandom(123);
    const start = performance.now();
    const result = estimate(
      cards('6d Jd Qd 8c'),
      cards('6d Jd Qd 8c 9s'),
      [0.4, 1],
      [0.3, 0.86],
      variantInfo(variant)
    );
    const ms = performance.now() - start;
    expect(result).not.toBeNull();
    expect(result!.samples).toBeGreaterThanOrEqual(96);
    expect(result!.madeShareDelta).toBeCloseTo(result!.currentShare - result!.previousShare);
    expect(fastRandom()).toBe(expected);
    expect(result!.heroNutMass).toBeGreaterThanOrEqual(0);
    expect(result!.heroNutMass).toBeLessThanOrEqual(1);
    expect(
      estimate(
        cards('6d Jd Qd 8c'),
        cards('6d Jd Qd 8c 9s'),
        [0.4, 1],
        [0.3, 0.86],
        variantInfo(variant)
      )
    ).toEqual(result);
    console.log(JSON.stringify({ variant, coldMs: ms, ...result }));
  }
});
it('refuses split, invalid, non-prefix and duplicate boards', () => {
  for (const variant of ['plo8', 'holdem'])
    expect(
      estimate(cards('2d 3d 4d'), cards('2d 3d 4d 8c'), [0.4, 1], [0.3, 0.86], variantInfo(variant))
    ).toBeNull();
  expect(
    estimate(cards('6d Jd Qd'), cards('6d Jd Qd 6d'), [0.4, 1], [0.3, 0.86], variantInfo('plo5'))
  ).toBeNull();
  expect(
    estimate(cards('6d Jd Qd'), cards('Jd 6d Qd 8c'), [0.4, 1], [0.3, 0.86], variantInfo('plo5'))
  ).toBeNull();
});
it('paired made-strength direction matches independent paired-share arithmetic and separates nut from mean equity', () => {
  const vi = variantInfo('plo4');
  const good = estimateIntegrated(cards('2c 2d 7h As'), [0.99, 1], [0, 0.1], vi, {
    previousBoard: cards('2c 2d 7h'),
  })!.madeRangeChange!;
  expect(good.currentShare).toBeGreaterThan(good.previousShare);
  expect(good.improves).toBe(true);
  expect(good.nutAdvantage).toBe(false);
  const bad = estimateIntegrated(cards('2c 3d 4h 5s'), [0.99, 1], [0, 0.1], vi, {
    previousBoard: cards('2c 3d 4h'),
  })!.madeRangeChange!;
  expect(bad.currentShare).toBeLessThan(bad.previousShare);
  expect(bad.worsens).toBe(true);
  const hilo = estimateIntegrated(
    cards('2c 3d 4h 5s'),
    [0.4, 1],
    [0.3, 0.86],
    variantInfo('plo8'),
    { previousBoard: cards('2c 3d 4h') }
  );
  expect(hilo).not.toBeNull();
  expect(hilo!.madeRangeChange).toBeUndefined();
  const noLow = estimateIntegrated(
    cards('6d Jd Qd 8c 9s'),
    [0.4, 1],
    [0.3, 0.86],
    variantInfo('plo8'),
    { previousBoard: cards('6d Jd Qd 8c') }
  );
  expect(noLow!.madeRangeChange).toBeDefined();
});
import { estimateRangeAdvantage as estimateIntegrated } from './HorseEval.js';
it('returns isolated nested cache snapshots', () => {
  const args = [
    cards('2c 2d 7h As'),
    [0.99, 1],
    [0, 0.1],
    variantInfo('plo4'),
    { previousBoard: cards('2c 2d 7h') },
  ] as const;
  const first = estimateIntegrated(args[0], [...args[1]], [...args[2]], args[3], args[4])!;
  const expected = first.madeRangeChange!.madeShareDelta;
  first.madeRangeChange!.madeShareDelta = 99;
  expect(
    estimateIntegrated(args[0], [...args[1]], [...args[2]], args[3], args[4])!.madeRangeChange!
      .madeShareDelta
  ).toBe(expected);
});

const estimate = (
  previous: Card[],
  current: Card[],
  h: [number, number],
  o: [number, number],
  vi: ReturnType<typeof variantInfo>
) => estimateIntegrated(current, h, o, vi, { previousBoard: previous })?.madeRangeChange ?? null;

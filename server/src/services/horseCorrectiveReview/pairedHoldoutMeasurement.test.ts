import { describe, expect, it } from 'vitest';
import { measurePairedHoldoutDeltas } from './pairedHoldoutMeasurement.js';
const plan = { maximumAbsoluteDelta: 1, familyWiseAlpha: 0.05, familySize: 1 };
describe('shared unit-neutral paired holdout numerical reduction', () => {
  it('matches independently calculated two-observation Hoeffding arithmetic', () => {
    const result = measurePairedHoldoutDeltas([1, -0.5], 2, plan);
    expect(result).toEqual({
      status: 'measured',
      samples: 2,
      changed: 2,
      meanGain: 0.25,
      lowerGain: 0.25 - Math.sqrt(Math.log(20)),
    });
  });
  it('counts retained zero deltas in the denominator and permits changed zero gains', () => {
    const result = measurePairedHoldoutDeltas([1, 0, 0, 0], 2, plan);
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw Error('measurement refused');
    expect(result.samples).toBe(4);
    expect(result.changed).toBe(2);
    expect(result.meanGain).toBe(0.25);
    expect(result.lowerGain).toBe(0.25 - Math.sqrt(Math.log(20) / 2));
    expect(measurePairedHoldoutDeltas([0, 0], 0, plan).status).toBe('measured');
    expect(measurePairedHoldoutDeltas([1, 0], 0, plan).status).toBe('unavailable');
  });
  it('preserves sequential addition and the existing full union-bound radius', () => {
    const deltas = [0.05, -0.02, 0.01, 0],
      p = { maximumAbsoluteDelta: 0.05, familyWiseAlpha: 0.01, familySize: 45 };
    const result = measurePairedHoldoutDeltas(deltas, 3, p);
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw Error('measurement refused');
    let sum = 0;
    for (const delta of deltas) sum += delta;
    expect(result.meanGain).toBe(sum / 4);
    expect(result.lowerGain).toBe(sum / 4 - 0.05 * Math.sqrt((2 * Math.log(4500)) / 4));
  });
  it('refuses invalid finite bounds, population sizes, family parameters and change counts', () => {
    for (const deltas of [
      [],
      [0],
      new Array(100001).fill(0),
      [NaN, 0],
      [Infinity, 0],
      [1.00001, 0],
    ])
      expect(measurePairedHoldoutDeltas(deltas, 0, plan).status).toBe('unavailable');
    for (const changed of [-1, 0.5, 3, NaN, Infinity])
      expect(measurePairedHoldoutDeltas([0, 0], changed, plan).status).toBe('unavailable');
    for (const patch of [
      { maximumAbsoluteDelta: 0 },
      { maximumAbsoluteDelta: 1e6 + 1 },
      { maximumAbsoluteDelta: Infinity },
      { familyWiseAlpha: 0 },
      { familyWiseAlpha: 0.05001 },
      { familyWiseAlpha: NaN },
      { familySize: 0 },
      { familySize: 1.1 },
      { familySize: 1000001 },
    ])
      expect(measurePairedHoldoutDeltas([0, 0], 0, { ...plan, ...patch }).status).toBe(
        'unavailable'
      );
  });
  it('accepts the exact upper finite population and bound without overflow', () => {
    const result = measurePairedHoldoutDeltas(new Array(100000).fill(1e6), 100000, {
      ...plan,
      maximumAbsoluteDelta: 1e6,
      familySize: 1e6,
    });
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw Error('measurement refused');
    expect(result.samples).toBe(100000);
    expect(result.meanGain).toBe(1e6);
    expect(Number.isFinite(result.lowerGain)).toBe(true);
    expect(
      measurePairedHoldoutDeltas([Number.MAX_VALUE, Number.MAX_VALUE], 2, {
        ...plan,
        maximumAbsoluteDelta: Number.MAX_VALUE,
      }).status
    ).toBe('unavailable');
  });
});

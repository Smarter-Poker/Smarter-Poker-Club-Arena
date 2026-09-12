import { describe, expect, it, vi } from 'vitest';
import { createIcmEquityEstimator } from './IcmModel.js';

describe('bounded continuation of an existing ICM workspace', () => {
  it.each([18, 200, 1000])(
    'matches a separately generated 128-trial estimator for %i players',
    (count) => {
      const stacks = Array.from({ length: count }, (_, i) => 500 + i * 3);
      const payouts = [45, 25, 15, 10, 5];
      const full = createIcmEquityEstimator(stacks, payouts, 1, [0, 1, 2]);
      const bounded = createIcmEquityEstimator(stacks, payouts, 1, [0, 1, 2], 128);
      const original = full.estimate(stacks);
      for (const transfer of [-stacks[1], -125, 0, 125, stacks[0]]) {
        const vector = stacks.slice();
        vector[0] -= transfer;
        vector[1] += transfer;
        expect(full.estimate(vector, 128)).toEqual(bounded.estimate(vector));
      }
      expect(full.estimate(stacks)).toEqual(original);
      expect(full.estimate(stacks, 128).errorBound).toBeGreaterThan(original.errorBound);
      const drifted = stacks.slice();
      drifted[count - 1] += 1;
      expect(() => full.estimate(drifted, 128)).toThrow('ICM remote stack changed');
    }
  );

  it('reuses generated clocks and cannot request more trials than the workspace contains', () => {
    const stacks = Array.from({ length: 200 }, (_, i) => 500 + i * 3);
    const workspace = createIcmEquityEstimator(stacks, [60, 30, 10], 0, [0, 1], 128);
    const expected = workspace.estimate(stacks);
    const log = vi.spyOn(Math, 'log');
    try {
      expect(workspace.estimate(stacks, 10000)).toEqual(expected);
      expect(workspace.estimate(stacks, 0).trials).toBe(96);
      expect(workspace.estimate(stacks, Number.NaN)).toEqual(expected);
      // Confidence calculations may use log; regenerating 200 x 96 clocks may not.
      expect(log.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps final-table equity exact regardless of a continuation work limit', () => {
    const stacks = [600, 400, 250, 0];
    const workspace = createIcmEquityEstimator(stacks, [65, 35], 0);
    expect(workspace.estimate(stacks, 128)).toEqual(workspace.estimate(stacks));
    expect(workspace.estimate(stacks, 128).errorBound).toBe(0);
  });
});

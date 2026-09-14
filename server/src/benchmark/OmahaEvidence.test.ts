import { describe, expect, it } from 'vitest';
import { defaultOmahaEvidence, runOmahaEvidence } from './OmahaEvidence.js';

describe('Phase 9 local evidence entry point', () => {
  it('executes every starter variant, range and multiboard scenario with conserved chips', async () => {
    const input = defaultOmahaEvidence();
    const report = await runOmahaEvidence(input);
    expect(report.complete).toBe(true);
    expect(report.completedScenarios).toBe(10);
    expect(report.maxConservationError).toBeLessThan(1e-8);
    expect(new Set(report.scenarios.map((s) => s.result.variant)).size).toBe(5);
    const river = report.scenarios.find((s) => s.name === 'plo8-weighted-river')!;
    expect(river.result.equity).toBe(0.4375);
    expect(river.components?.[0].hand.lowRanks).toEqual([8, 4, 3, 2, 1]);
    const side = report.scenarios.find((s) => s.name === 'plo8-quartering-side-pot-refund')!;
    expect(side.result.refunds.low).toBe(50);
    expect(side.result.expectedChips).toBe(75);
    expect(report.scenarios.filter((s) => s.result.method.includes('monte_carlo'))).toHaveLength(3);
  });
  it('stops the batch with explicit incomplete evidence on cancellation', async () => {
    const report = await runOmahaEvidence(defaultOmahaEvidence(), () => false);
    expect(report.complete).toBe(false);
    expect(report.completedScenarios).toBe(0);
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0].result.reason).toBe('cancelled');
  });
  it('rejects empty, ambiguous or oversized batches', async () => {
    const input = defaultOmahaEvidence();
    await expect(runOmahaEvidence({ ...input, scenarios: [] })).rejects.toThrow('one to sixteen');
    await expect(
      runOmahaEvidence({ ...input, scenarios: [...input.scenarios, ...input.scenarios] })
    ).rejects.toThrow('one to sixteen');
    await expect(
      runOmahaEvidence({ ...input, scenarios: [input.scenarios[0], input.scenarios[0]] })
    ).rejects.toThrow('uniquely');
  });
});

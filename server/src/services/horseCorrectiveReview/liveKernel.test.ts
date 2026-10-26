import { describe, it, expect, vi } from 'vitest';
import { catalog, approved, running } from './kernelApproval.test-support.js';
import { validateCorrectiveKernelCatalog } from './kernelCatalog.js';
import { riverReferenceFixture, bind } from './riverReference.test-support.js';
import { evaluateAdmittedRiverKernel } from './liveKernel.js';
const admitted = () => {
  const c = catalog(),
    r = validateCorrectiveKernelCatalog(c, approved(c), running(c));
  if (r.status !== 'validated') throw Error(r.reason);
  return r.catalog;
};
const original = () => {
  const i = riverReferenceFixture();
  i.stack = 200;
  bind(i);
  return i.original;
};
const baseline = () => ({ action: 'fold' as const, thinkTime: 500 });
describe('decision-time original-state corrective applier', () => {
  it('does no work or random draw for an absent or copied catalog', () => {
    const b = baseline(),
      draw = vi.fn(() => 0),
      source = original();
    for (const c of [null, structuredClone(admitted())]) {
      const r = evaluateAdmittedRiverKernel(c, source, b, draw);
      expect(r.decision).toBe(b);
      expect(r.receipt).toBeNull();
    }
    expect(draw).not.toHaveBeenCalled();
  });
  it('applies a bounded profitable correction using only the original state', () => {
    const draw = vi.fn(() => 0.049999),
      b = baseline();
    const r = evaluateAdmittedRiverKernel(admitted(), original(), b, draw);
    expect(r.decision).toMatchObject({ action: 'call', amount: 50, thinkTime: 500 });
    expect(r.receipt).toMatchObject({
      version: 'horse-corrective-live-kernel-v1',
      domain: 'nlh-cash',
      applied: true,
      conditionalProbability: 0.05,
      baseline: { action: 'fold', amount: 0 },
      selected: { action: 'call', amount: 50 },
    });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(b).toEqual(baseline());
  });
  it('retains the baseline above the five-percent boundary', () => {
    const b = baseline(),
      r = evaluateAdmittedRiverKernel(admitted(), original(), b, () => 0.05);
    expect(r.decision).toBe(b);
    expect(r.receipt).toMatchObject({
      applied: false,
      reason: 'not_sampled',
      selected: { action: 'fold', amount: 0 },
    });
  });
  it.each([NaN, -0.1, 1, Infinity])(
    'refuses invalid random draw %s without a wager change',
    (draw) => {
      const b = baseline(),
        r = evaluateAdmittedRiverKernel(admitted(), original(), b, () => draw);
      expect(r.decision).toBe(b);
      expect(r.receipt?.applied).not.toBe(true);
    }
  );
  it('does not draw for another domain, unsupported action or already-preferred action', () => {
    const o = original(),
      draw = vi.fn(() => 0);
    o.snapshot.gameState.gameVariant = 'plo5';
    expect(evaluateAdmittedRiverKernel(admitted(), o, baseline(), draw).receipt).toBeNull();
    const source = original();
    for (const b of [
      { action: 'raise' as const, amount: 100, thinkTime: 0 },
      { action: 'call' as const, amount: 50, thinkTime: 0 },
    ])
      expect(evaluateAdmittedRiverKernel(admitted(), source, b, draw).decision).toBe(b);
    expect(draw).not.toHaveBeenCalled();
  });
  it.each([
    'multiway_commitment_floor',
    'dominated_commitment_floor',
    'omaha_cold_flush_pressure',
  ] as const)(
    'never reopens a catastrophe-protected %s fold or consumes RNG',
    (continuationGuard) => {
      const b = { ...baseline(), continuationGuard },
        draw = vi.fn(() => 0);
      const r = evaluateAdmittedRiverKernel(admitted(), original(), b, draw);
      expect(r.decision).toBe(b);
      expect(r.receipt).toBeNull();
      expect(draw).not.toHaveBeenCalled();
    }
  );
});

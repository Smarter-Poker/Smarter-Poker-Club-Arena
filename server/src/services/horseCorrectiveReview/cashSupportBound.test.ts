import { describe, it, expect, vi } from 'vitest';
import {
  evaluateRiverHoldout,
  type RiverHoldoutPlan,
  type RiverHoldoutCase,
} from './riverHoldout.js';
import { riverReferenceFixture, bind } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
function fixture() {
  const plan: RiverHoldoutPlan = {
    sourceRelease: '1'.repeat(40),
    producerDigest: 'a'.repeat(64),
    qualificationId: 'qualification-required',
    evidenceClass: 'synthetic_fixture',
    declaredAt: '2026-10-24T00:00:00.000Z',
    holdoutStartsAt: '2026-10-25T00:00:00.000Z',
    holdoutEndsAt: '2026-10-26T00:00:00.000Z',
    selectionHandKeys: [evidenceDigest('selection')],
    minimumSamples: 2,
    maximumAbsoluteDeltaBb: 5,
    familyWiseAlpha: 0.05,
    familySize: 45,
  };
  const rows: RiverHoldoutCase[] = [0, 1].map((n) => {
    const input = bind({ ...riverReferenceFixture(), stack: 200 });
    input.binding.decisionDigest = evidenceDigest(['decision', n]);
    input.binding.acceptedHandDigest = evidenceDigest(['accepted', n]);
    return {
      handKey: evidenceDigest(['hand', n]),
      playedAt: '2026-10-25T00:01:00.000Z',
      input,
      baseline: { action: 'fold', amount: 0 },
      oracle: { foldBb: 0, callBb: 0.001 },
    };
  });
  return { plan, rows };
}
// Mean/lower/digest pins were captured from the unmodified v1 evaluator on
// these exact synthetic rows before hardening; no duplicate evaluator ships.
describe('predictable cash support before hidden outcomes', () => {
  it('refuses tiny observed gain under an ex ante insufficient bound accepted by the old measurement', () => {
    const { plan, rows } = fixture();
    plan.maximumAbsoluteDeltaBb = 0.001;
    expect(0.05 * rows[0]!.oracle.callBb).toBeLessThan(plan.maximumAbsoluteDeltaBb);
    expect(evaluateRiverHoldout(plan, rows)).toMatchObject({
      status: 'unavailable',
      reasons: ['holdout_predeclared_support_unproven'],
    });
  });
  it('never reads hidden outcomes to admit the support bound', () => {
    const { plan, rows } = fixture();
    plan.maximumAbsoluteDeltaBb = 4.999999999999999;
    const read = vi.fn(() => {
      throw Error('hidden outcome accessed');
    });
    Object.defineProperty(rows[0], 'oracle', { get: read });
    expect(evaluateRiverHoldout(plan, rows).reasons).toEqual([
      'holdout_predeclared_support_unproven',
    ]);
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps exact valid mean/lower/digest bytes for sufficient B and both changed directions', () => {
    for (const call of [48, -25]) {
      const { plan, rows } = fixture();
      rows.forEach((r) => (r.oracle.callBb = call));
      expect(evaluateRiverHoldout(plan, rows)).toEqual({
        status: 'measured',
        reasons: [],
        samples: 2,
        changed: 2,
        meanGainBb: call === 48 ? 2.4000000000000004 : -1.25,
        lowerGainBb: call === 48 ? -10.640700482838634 : -14.290700482838634,
        qualified: false,
        activationAllowed: false,
        measurementDigest:
          call === 48
            ? 'bc0898c0df3b132479e9df4e141a742da4d525bb7036fe180109195b2a96e323'
            : '313b314103352ed2dde9f44437ed4dd09beff6f72ec53a31b68f76ee8417eb70',
      });
    }
  });
  it('retains deterministic policy exclusions in denominator with zero support', () => {
    const { plan, rows } = fixture();
    plan.maximumAbsoluteDeltaBb = 0.001;
    rows.forEach((r) => (r.retainedByPolicy = 'protected_continuation'));
    const result = evaluateRiverHoldout(plan, rows);
    expect(result).toMatchObject({
      lowerGainBb: -0.002608140096567727,
      measurementDigest: '03ba965feacf74f2d98864146b01f3b20f65faa69864b7caa05f1b7292535228',
    });
    expect(result).toMatchObject({ status: 'measured', samples: 2, changed: 0, meanGainBb: 0 });
  });
  it('refuses unsupported changed geometry rather than assert a settlement bound', () => {
    for (const change of [
      (r: any) => r.input.original.snapshot.gameState.dealtSeatIds.push(3),
      (r: any) => (r.input.original.snapshot.gameState.ante = 1),
      (r: any) => {
        r.input.stack = r.input.toCall;
        bind(r.input);
      },
    ]) {
      const f = fixture();
      change(f.rows[0]);
      expect(evaluateRiverHoldout(f.plan, f.rows).status).toBe('unavailable');
    }
  });
});

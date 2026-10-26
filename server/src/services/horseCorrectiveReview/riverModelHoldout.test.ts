import { describe, it, expect } from 'vitest';
import {
  evaluateRiverDecisionModelHoldout,
  type RiverModelHoldoutPlan,
  type RiverModelHoldoutCase,
} from './riverModelHoldout.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './riverKernel.js';
import { riverReferenceFixture, cards, bind } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
import type { RiverHoldoutCase } from './riverHoldout.js';
const plan = (): RiverModelHoldoutPlan => ({
  sourceRelease: '1'.repeat(40),
  producerDigest: 'a'.repeat(64),
  qualificationId: 'qualification-required',
  evidenceClass: 'synthetic_fixture',
  modelVersion: RIVER_DECISION_MODEL.version,
  policyVersion: RIVER_CORRECTION_KERNEL.version,
  declaredAt: '2026-10-24T00:00:00.000Z',
  holdoutStartsAt: '2026-10-25T00:00:00.000Z',
  holdoutEndsAt: '2026-10-26T00:00:00.000Z',
  selectionHandKeys: [evidenceDigest('selection')],
  minimumSamples: 2,
  maximumAbsoluteDeltaBb: 5,
  familyWiseAlpha: 0.05,
  familySize: 45,
});
const rows = (): RiverModelHoldoutCase[] =>
  [0, 1].map((n) => {
    const input = riverReferenceFixture();
    input.stack = 200;
    bind(input);
    input.binding.decisionDigest = evidenceDigest(['decision', n]);
    input.binding.acceptedHandDigest = evidenceDigest(['accepted', n]);
    return {
      handKey: evidenceDigest(['hand', n]),
      playedAt: '2026-10-25T01:00:00.000Z',
      input,
      baseline: { action: 'fold', amount: 0 },
      baselineDecision: { action: 'fold', thinkTime: 0 },
      oracle: { foldBb: 0, callBb: 48 },
    };
  });
describe('holdout of the actual original-only functional policy', () => {
  it('measures the locked model reconstructed from original state', () => {
    expect(evaluateRiverDecisionModelHoldout(plan(), rows())).toMatchObject({
      status: 'measured',
      samples: 2,
      changed: 2,
      qualified: false,
      activationAllowed: false,
    });
  });
  it('cannot select a more favorable retrospective range instead of its declared model', () => {
    const a = rows(),
      b = structuredClone(a);
    b.forEach((r) => (r.input.range = [{ cards: cards('As Ah'), weight: 1 }]));
    const first = evaluateRiverDecisionModelHoldout(plan(), a),
      second = evaluateRiverDecisionModelHoldout(plan(), b);
    expect(first.status).toBe('measured');
    expect(second).toEqual(first);
  });
  it('refuses another model version instead of silently evaluating the current one', () => {
    expect(
      evaluateRiverDecisionModelHoldout({ ...plan(), modelVersion: 'another-model' }, rows()).status
    ).toBe('unavailable');
  });
  it.each(['guard', 'earlier', 'all_in'])(
    'counts %s exclusions as unchanged full-policy holdout hands',
    (fault) => {
      const r = rows();
      for (const row of r) {
        if (fault === 'guard')
          row.baselineDecision.continuationGuard = 'dominated_commitment_floor';
        if (fault === 'earlier') row.baselineDecision.jointPolicy = { applied: true } as never;
        if (fault === 'all_in') {
          row.input.stack = row.input.toCall;
          bind(row.input);
        }
      }
      expect(evaluateRiverDecisionModelHoldout(plan(), r)).toMatchObject({
        status: 'measured',
        samples: 2,
        changed: 0,
        meanGainBb: 0,
      });
    }
  );
  it('refuses missing full baseline policy rather than certifying raw action-only rows', () => {
    const r = rows();
    delete (r[0] as Partial<RiverModelHoldoutCase>).baselineDecision;
    expect(evaluateRiverDecisionModelHoldout(plan(), r)).toMatchObject({
      status: 'unavailable',
      reasons: ['holdout_baseline_policy_unavailable'],
    });
  });
});

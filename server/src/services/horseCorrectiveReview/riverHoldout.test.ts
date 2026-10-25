import { describe, it, expect } from 'vitest';
import {
  evaluateRiverHoldout,
  type RiverHoldoutPlan,
  type RiverHoldoutCase,
} from './riverHoldout.js';
import { riverReferenceFixture, bind, cards } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
const plan = (): RiverHoldoutPlan => ({
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
});
const rows = (): RiverHoldoutCase[] =>
  [0, 1].map((n) => ({
    handKey: evidenceDigest(['holdout', n]),
    playedAt: '2026-10-25T00:01:00.000Z',
    input: {
      ...riverReferenceFixture(),
      binding: {
        ...riverReferenceFixture().binding,
        decisionEventId: `decision-${n}`,
        decisionDigest: evidenceDigest(['decision', n]),
        acceptedHandDigest: evidenceDigest(['hand', n]),
      },
    },
    baseline: { action: 'fold', amount: 0 },
    oracle: { foldBb: 0, callBb: 48 },
  }));
describe('independent river policy holdout measurement', () => {
  it('hashes a fleet-sized measurement without the single-journal-record byte ceiling', () => {
    const cases = Array.from({ length: 1000 }, (_, n) => {
      const row = rows()[0]!;
      row.handKey = evidenceDigest(['fleet-hand', n]);
      row.input.binding.decisionDigest = evidenceDigest(['fleet-decision', n]);
      row.input.binding.acceptedHandDigest = evidenceDigest(['fleet-accepted', n]);
      return row;
    });
    const result = evaluateRiverHoldout(plan(), cases);
    expect(result).toMatchObject({
      status: 'measured',
      samples: 1000,
      changed: 1000,
      qualified: false,
    });
    expect(result.measurementDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('measures the actual five-percent distribution shift and retains uncertainty', () => {
    const r = evaluateRiverHoldout(plan(), rows());
    expect(r).toMatchObject({
      status: 'measured',
      samples: 2,
      changed: 2,
      qualified: false,
      activationAllowed: false,
    });
    expect(r.meanGainBb).toBeCloseTo(2.4, 12);
    expect(r.lowerGainBb).toBeLessThan(r.meanGainBb!);
  });
  it('does not feed hidden oracle outcomes into the policy', () => {
    const a = rows(),
      b = structuredClone(a);
    b.forEach((x) => (x.oracle.callBb = -25));
    expect(evaluateRiverHoldout(plan(), a).changed).toBe(2);
    expect(evaluateRiverHoldout(plan(), b)).toMatchObject({ changed: 2, meanGainBb: -1.25 });
  });
  it('includes unchanged hands in the denominator', () => {
    const r = rows();
    r[1]!.baseline = { action: 'call', amount: 50 };
    const measured = evaluateRiverHoldout(plan(), r);
    expect(measured).toMatchObject({ samples: 2, changed: 1 });
    expect(measured.meanGainBb).toBeCloseTo(1.2, 12);
  });
  it.each([
    'overlap',
    'duplicate',
    'duplicate-source',
    'source',
    'producer',
    'bound',
    'sample',
    'time',
    'outside-window',
    'end-boundary',
    'alpha',
    'invalid-input',
    'invalid-oracle',
  ])('refuses %s without silently dropping a holdout hand', (kind) => {
    const p = plan(),
      r = rows();
    if (kind === 'overlap') p.selectionHandKeys.push(r[0]!.handKey);
    if (kind === 'duplicate') r[1]!.handKey = r[0]!.handKey;
    if (kind === 'duplicate-source') r[1]!.input.binding = { ...r[0]!.input.binding };
    if (kind === 'source') r[1]!.input.binding.sourceRelease = '2'.repeat(40);
    if (kind === 'producer') r[1]!.input.producerDigest = '3'.repeat(64);
    if (kind === 'bound') p.maximumAbsoluteDeltaBb = 1;
    if (kind === 'sample') p.minimumSamples = 3;
    if (kind === 'time') p.declaredAt = p.holdoutStartsAt;
    if (kind === 'outside-window') r[0]!.playedAt = '2026-10-24T23:59:59.999Z';
    if (kind === 'end-boundary') r[0]!.playedAt = p.holdoutEndsAt;
    if (kind === 'alpha') p.familyWiseAlpha = 1;
    if (kind === 'invalid-input') {
      r[0]!.input.hero = cards('Ks Kh');
      bind(r[0]!.input);
    }
    if (kind === 'invalid-oracle') r[0]!.oracle.callBb = NaN;
    expect(evaluateRiverHoldout(p, r).status).toBe('unavailable');
  });
});

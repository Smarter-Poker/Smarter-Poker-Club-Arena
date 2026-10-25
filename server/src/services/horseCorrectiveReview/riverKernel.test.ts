import { describe, expect, it } from 'vitest';
import { proposeRiverCallFoldCorrection } from './riverKernel.js';
import { produceRiverCallFoldReference } from './riverReference.js';
import { cards, bind, riverReferenceFixture } from './riverReference.test-support.js';

describe('bounded Phase 14 river call/fold policy kernel', () => {
  it('proposes a maximum five-point move from a fold to a conservatively profitable call', () => {
    const i = riverReferenceFixture(),
      r = produceRiverCallFoldReference(i);
    if (r.status !== 'produced') throw Error(r.reason);
    const p = proposeRiverCallFoldCorrection(i, { action: 'fold', amount: 0 }, r.reference);
    expect(p).toMatchObject({
      status: 'proposed',
      from: { action: 'fold', amount: 0 },
      to: { action: 'call', amount: 50 },
      conditionalProbability: 0.05,
      modelGainLowerBb: 48,
      activationAllowed: false,
    });
  });
  it('proposes folding a losing call, without changing any other decision family', () => {
    const i = riverReferenceFixture();
    i.hero = cards('Ks Kh');
    i.range = [{ cards: cards('As Ah'), weight: 1 }];
    bind(i);
    const r = produceRiverCallFoldReference(i);
    if (r.status !== 'produced') throw Error(r.reason);
    expect(
      proposeRiverCallFoldCorrection(i, { action: 'call', amount: 50 }, r.reference)
    ).toMatchObject({
      status: 'proposed',
      to: { action: 'fold', amount: 0 },
      modelGainLowerBb: 25,
    });
    expect(
      proposeRiverCallFoldCorrection(i, { action: 'raise', amount: 100 }, r.reference).status
    ).toBe('unavailable');
  });
  it('retains already-preferred decisions and overlapping intervals', () => {
    const i = riverReferenceFixture(),
      r = produceRiverCallFoldReference(i);
    if (r.status !== 'produced') throw Error(r.reason);
    expect(
      proposeRiverCallFoldCorrection(i, { action: 'call', amount: 50 }, r.reference).status
    ).toBe('retained');
    r.reference.alternatives[1]!.lower = -1;
    expect(
      proposeRiverCallFoldCorrection(i, { action: 'fold', amount: 0 }, r.reference).status
    ).toBe('retained');
  });
  it.each(['binding', 'domain', 'menu', 'utility', 'uncertainty', 'producer', 'range-contract'])(
    'refuses corrupted %s reference evidence',
    (field) => {
      const i = riverReferenceFixture(),
        r = produceRiverCallFoldReference(i);
      if (r.status !== 'produced') throw Error(r.reason);
      const v = r.reference;
      if (field === 'binding') v.binding.inputDigest = '0'.repeat(64);
      if (field === 'domain') v.domain.variant = 'plo5';
      if (field === 'menu') v.alternatives[1]!.choice.amount = 49;
      if (field === 'utility') v.utility.costsIncluded = false as never;
      if (field === 'uncertainty') v.uncertainty.familyWiseConfidence = 0.9;
      if (field === 'producer') v.producerDigest = '0'.repeat(64);
      if (field === 'range-contract') v.samplingContractDigest = '0'.repeat(64);
      expect(proposeRiverCallFoldCorrection(i, { action: 'fold', amount: 0 }, v).status).toBe(
        'unavailable'
      );
    }
  );
});

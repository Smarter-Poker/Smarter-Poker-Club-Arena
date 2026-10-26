import { describe, it, expect, vi, afterEach } from 'vitest';
import { reviewRiverEnumeration } from './riverIndependentReview.js';
import * as producer from './riverReference.js';
import { riverReferenceFixture, bind, cards } from './riverReference.test-support.js';
afterEach(() => vi.restoreAllMocks());
describe('independent numerical review before reference signing', () => {
  it('reproduces residual-cent allocation in a raked quartered hi-lo pot', () => {
    const i = riverReferenceFixture();
    i.domain.variant = 'plo8';
    i.hero = cards('As 2s Kh Kd');
    i.board = cards('3c 4d 8h Kc Qd');
    i.range = [{ cards: cards('Ah 2h Qc Qh'), weight: 1 }];
    i.finalRake = 4.01;
    const r = producer.produceRiverCallFoldReference(bind(i));
    if (r.status !== 'produced') throw Error(r.reason);
    expect(r.reference.alternatives[1]!.mean).toBeCloseTo(29.745, 10);
    expect(reviewRiverEnumeration(i, r.reference).status).toBe('numerically_consistent');
  });
  it.each([
    'nlh',
    'flh',
    'pineapple',
    'short_deck',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
  ] as const)('independently enumerates the %s ranking, pot shares and deductions', (variant) => {
    const i = riverReferenceFixture();
    i.domain.variant = variant;
    const n =
      variant === 'plo5'
        ? 5
        : variant === 'plo6'
          ? 6
          : ['plo4', 'plo8', 'flo8'].includes(variant)
            ? 4
            : 2;
    i.hero = cards('As Ah 2s 3s 4s 5s'.split(' ').slice(0, n).join(' '));
    i.range = [{ cards: cards('Ks Kh 2h 3h 4h 5h'.split(' ').slice(0, n).join(' ')), weight: 1 }];
    const r = producer.produceRiverCallFoldReference(bind(i));
    if (r.status !== 'produced') throw Error(r.reason);
    expect(reviewRiverEnumeration(i, r.reference)).toMatchObject({
      status: 'numerically_consistent',
      checkedCombinations: 1,
      qualified: false,
      activationAllowed: false,
    });
  });
  it('detects a numeric producer bug even when that producer reproduces the same wrong reference', () => {
    const i = riverReferenceFixture(),
      r = producer.produceRiverCallFoldReference(i);
    if (r.status !== 'produced') throw Error(r.reason);
    const wrong = structuredClone(r);
    wrong.reference.alternatives[1]!.mean++;
    wrong.reference.alternatives[1]!.lower++;
    wrong.reference.alternatives[1]!.upper++;
    vi.spyOn(producer, 'produceRiverCallFoldReference').mockReturnValue(wrong);
    expect(reviewRiverEnumeration(i, wrong.reference).status).toBe('mismatch');
  });
  it('refuses a changed original binding before reporting numerical agreement', () => {
    const i = riverReferenceFixture(),
      r = producer.produceRiverCallFoldReference(i);
    if (r.status !== 'produced') throw Error(r.reason);
    r.reference.binding.inputDigest = '0'.repeat(64);
    expect(reviewRiverEnumeration(i, r.reference).status).toBe('unavailable');
  });
  it('checks every declared weighted combination, not only the best outcome', () => {
    const i = riverReferenceFixture();
    i.board = cards('2s 3s 4s 5s 6s');
    i.hero = cards('Ah Ad');
    i.range = [
      { cards: cards('Kh Kd'), weight: 3 },
      { cards: cards('7s 7d'), weight: 1 },
    ];
    i.finalRake = 0;
    const r = producer.produceRiverCallFoldReference(bind(i));
    if (r.status !== 'produced') throw Error(r.reason);
    expect(reviewRiverEnumeration(i, r.reference)).toMatchObject({
      status: 'numerically_consistent',
      checkedCombinations: 2,
    });
  });
});

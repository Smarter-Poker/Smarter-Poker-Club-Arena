import { describe, expect, it } from 'vitest';
import { reviewCorrectiveKernelNumerics } from './kernelIndependentReview.js';
import { riverReferenceFixture } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
import type { RiverReferenceInput } from './riverReference.js';

function row(index = 0): RiverReferenceInput {
  const input = riverReferenceFixture();
  input.binding.decisionDigest = (index + 1).toString(16).padStart(64, '0');
  input.binding.acceptedHandDigest = (index + 20).toString(16).padStart(64, '0');
  input.binding.executionDigest = (index + 40).toString(16).padStart(64, '0');
  input.original.snapshot.requestId += index;
  // The original binding is intentionally recomputed exactly as a producer
  // would: these remain synthetic source bytes and cannot grant source trust.
  input.binding.inputDigest = evidenceDigest(input.original.snapshot);
  return input;
}

describe('fixed-model independent numerical batch review', () => {
  it('rebuilds and independently checks each fixed finite model without approving source or activation', () => {
    const result = reviewCorrectiveKernelNumerics([row()]);
    expect(result).toMatchObject({
      status: 'numerically_consistent',
      checkedCases: 1,
      checkedCombinations: 32,
      qualified: false,
      sourceReadVerified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    expect(result.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/hero|opponent|As|Ah|declaredRange/);
  });

  it('ignores a retrospectively substituted range and independently prices the actual fixed model', () => {
    const original = row(),
      substituted = structuredClone(original);
    substituted.range = [{ cards: [], weight: -1 }];
    substituted.rangeDigest = '0'.repeat(64);
    expect(reviewCorrectiveKernelNumerics([substituted])).toEqual(
      reviewCorrectiveKernelNumerics([original])
    );
  });

  it('commits ordered, distinct decisions without serializing the whole population', () => {
    const one = row(),
      two = row(1);
    const result = reviewCorrectiveKernelNumerics([one, two]);
    expect(result).toMatchObject({
      status: 'numerically_consistent',
      checkedCases: 2,
      checkedCombinations: 64,
    });
    expect(reviewCorrectiveKernelNumerics([two, one]).reviewDigest).not.toBe(result.reviewDigest);
    expect(reviewCorrectiveKernelNumerics([one, one])).toMatchObject({
      status: 'unavailable',
      reason: 'numerical_source_reused',
    });
  });

  it.each([
    'missing-binding',
    'hidden-cards',
    'dead-money',
    'range-model-card',
    'duplicate-hand',
  ] as const)('refuses %s rather than returning a successful partial review', (fault) => {
    const first = row(),
      second = row(1);
    if (fault === 'missing-binding') second.binding.inputDigest = '0'.repeat(64);
    if (fault === 'hidden-cards')
      second.original.snapshot.gameState.players[1].cards = structuredClone(second.hero);
    if (fault === 'dead-money') second.original.snapshot.gameState.players[1].deadInvested = 1;
    if (fault === 'range-model-card') second.original.snapshot.player.cards[0].rank = '1' as never;
    if (fault === 'duplicate-hand')
      second.binding.acceptedHandDigest = first.binding.acceptedHandDigest;
    const result = reviewCorrectiveKernelNumerics([first, second]);
    expect(result.status).not.toBe('numerically_consistent');
    expect(result.reviewDigest).toBeNull();
    expect(result.qualified).toBe(false);
    expect(result.activationAllowed).toBe(false);
  });

  it('refuses empty or oversized input without running an unbounded review', () => {
    expect(reviewCorrectiveKernelNumerics([])).toMatchObject({
      status: 'unavailable',
      reason: 'numerical_batch_bounds',
    });
    expect(reviewCorrectiveKernelNumerics(Array(10001).fill(null))).toMatchObject({
      status: 'unavailable',
      reason: 'numerical_batch_bounds',
    });
  });
});

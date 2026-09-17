import { describe, expect, it } from 'vitest';
import { correctiveFixture, HAND_KEY } from '../horseCorrectiveReview/fixture.test-support.js';
import { horseLifecycleRequestDigest } from './lifecycle.js';
import { reconcileHorseJournalHand } from './review.js';

function retainedRecords(lifecycleVersion: unknown, includePair = true) {
  const f = correctiveFixture();
  const requestDigest = horseLifecycleRequestDigest(f.snapshot);
  return [
    ...(includePair
      ? [
          f.make('request_lifecycle', 1, {
            version: 1,
            phase: 'requested',
            origin: 'worker_compute',
            request: f.snapshot,
            requestDigest,
          }),
        ]
      : []),
    f.make('decision', 2, { ...f.capture, lifecycleVersion }),
    ...(includePair
      ? [
          f.make('request_lifecycle', 3, {
            version: 1,
            phase: 'terminal',
            requestDigest,
            outcome: 'success',
          }),
        ]
      : []),
    f.make('execution', 4, f.witness),
    f.make('accepted_hand', 5, f.hand),
  ];
}

describe('retained decision lifecycle version qualification', () => {
  it.each([42, 0, '1', null])(
    'refuses unsupported version %s despite an exact lifecycle pair',
    (version) => {
      const result = reconcileHorseJournalHand(retainedRecords(version), HAND_KEY);
      expect(result.status).toBe('incomplete');
      expect(result.requestLifecycleVerified).toBe(false);
      expect(result.gaps).toContain('request_lifecycle_mismatch');
    }
  );
  it.each([42, 0, '1', null])(
    'refuses unsupported version %s without a lifecycle pair',
    (version) => {
      const result = reconcileHorseJournalHand(retainedRecords(version, false), HAND_KEY);
      expect(result.status).toBe('incomplete');
      expect(result.requestLifecycleVerified).toBe(false);
      expect(result.gaps).toContain('request_lifecycle_mismatch');
    }
  );
  it('verifies numeric version 1 only with its complete matching pair', () => {
    const result = reconcileHorseJournalHand(retainedRecords(1), HAND_KEY);
    expect(result.status).toBe('reconciled');
    expect(result.requestLifecycleVerified).toBe(true);
    expect(result.gaps).toEqual([]);
  });
  it('preserves legacy structural joins without inventing lifecycle proof', () => {
    const result = reconcileHorseJournalHand(retainedRecords(undefined, false), HAND_KEY);
    expect(result.status).toBe('reconciled');
    expect(result.requestLifecycleVerified).toBe(false);
    expect(result.gaps).toEqual([]);
  });
  it('requires the pair for numeric version 1', () => {
    const result = reconcileHorseJournalHand(retainedRecords(1, false), HAND_KEY);
    expect(result.status).toBe('incomplete');
    expect(result.requestLifecycleVerified).toBe(false);
    expect(result.gaps).toContain('request_lifecycle_missing');
  });
});

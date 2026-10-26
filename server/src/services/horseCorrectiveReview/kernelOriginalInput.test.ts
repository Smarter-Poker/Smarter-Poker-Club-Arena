import { describe, it, expect } from 'vitest';
import {
  resolveKernelOriginalInput,
  resolveKernelRetainedFastInput,
  kernelReconciledExecutionDisposition,
} from './kernelOriginalInput.js';
import { correctiveFixture } from './fixture.test-support.js';
import { evidenceDigest } from './authority.js';
import { correctiveReferenceBinding } from './review.js';
import {
  makeHorseJournalRecord,
  type HorseJournalRecord,
  journalHash,
} from '../horseDecisionJournal/record.js';
function fixture() {
  const f = correctiveFixture(),
    base = f.records[0],
    fastCapture = JSON.parse(base.body);
  const make = (
    kind: HorseJournalRecord['kind'],
    sequence: number,
    body: unknown,
    overrides: Partial<HorseJournalRecord> = {}
  ) =>
    makeHorseJournalRecord(
      {
        producerId: base.producerId,
        sequence,
        atMs: base.atMs,
        sourceRelease: base.sourceRelease,
        kind,
        handKey: base.handKey,
        turnKey:
          kind === 'accepted_hand'
            ? base.handKey
            : sequence < 5
              ? base.turnKey
              : journalHash('deep-turn'),
        ...overrides,
      },
      body
    );
  const fast = make('decision', 1, fastCapture),
    snapshot = {
      ...fastCapture.snapshot,
      type: 'DECIDE_DEEP',
      requestId: fastCapture.snapshot.requestId + 1,
      rngBefore: fastCapture.rngBefore,
      deepEquity: 2,
    };
  const deepCapture = {
    ...fastCapture,
    snapshot,
    originalFastBinding: {
      inputDigest: evidenceDigest(fastCapture.snapshot),
      readFrameDigest: evidenceDigest(fastCapture.readFrame),
    },
  };
  const deep = make('decision', 5, deepCapture),
    execution = make('execution', 6, {}),
    accepted = make('accepted_hand', 7, f.hand);
  const records = [fast, deep, execution, accepted];
  return { f, fastCapture, fast, deepCapture, deep, execution, accepted, records, make };
}
describe('kernel actual decision and retained FAST dual binding', () => {
  it('retains generic FAST binding unchanged', () => {
    const a = fixture(),
      execution = a.make('execution', 2, {}),
      records = [a.fast, execution, a.accepted];
    const result = resolveKernelOriginalInput(records, a.fast, execution, a.accepted);
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.binding).toEqual(correctiveReferenceBinding(a.fast, execution, a.accepted));
      expect(result.binding).not.toHaveProperty('kernelOriginal');
    }
  });
  it('keeps actual accepted DEEP identity separate from retained original FAST information', () => {
    const a = fixture(),
      result = resolveKernelOriginalInput(a.records, a.deep, a.execution, a.accepted);
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.decisionSnapshot.type).toBe('DECIDE_DEEP');
      expect(result.original.snapshot.type).toBe('DECIDE_FAST');
      expect(result.originalFastRecord.sha256).toBe(a.fast.sha256);
      expect(result.executionBinding).toEqual(
        correctiveReferenceBinding(a.deep, a.execution, a.accepted)
      );
      expect(result.binding).toMatchObject({
        decisionDigest: a.deep.sha256,
        inputDigest: evidenceDigest(a.fastCapture.snapshot),
        readFrameDigest: evidenceDigest(a.fastCapture.readFrame),
        kernelOriginal: {
          version: 'horse-kernel-original-reference-v1',
          decisionDigest: a.fast.sha256,
          executedInputDigest: evidenceDigest(a.deepCapture.snapshot),
        },
      });
      expect(result.binding.inputDigest).not.toBe(result.executionBinding.inputDigest);
    }
  });
  it.each([
    'missing-metadata',
    'extra-metadata',
    'frame',
    'rng',
    'producer',
    'source',
    'hand',
    'sequence',
    'canonical-key',
    'missing-fast',
    'duplicate-fast',
  ] as const)('refuses %s instead of substituting a FAST-shaped DEEP request', (fault) => {
    const a = fixture();
    let deep = a.deep,
      records = a.records;
    if (fault === 'missing-metadata') {
      const { originalFastBinding, ...capture } = a.deepCapture;
      deep = a.make('decision', 5, capture);
    }
    if (fault === 'extra-metadata')
      deep = a.make('decision', 5, {
        ...a.deepCapture,
        originalFastBinding: { ...a.deepCapture.originalFastBinding, qualified: true },
      });
    if (fault === 'frame')
      deep = a.make('decision', 5, { ...a.deepCapture, readFrame: { future: true } });
    if (fault === 'rng')
      deep = a.make('decision', 5, { ...a.deepCapture, rngBefore: a.deepCapture.rngBefore + 1 });
    if (fault === 'canonical-key')
      deep = a.make('decision', 5, {
        ...a.deepCapture,
        snapshot: { ...a.deepCapture.snapshot, decisionKey: 'forged' },
      });
    if (fault === 'producer')
      records = [
        a.make('decision', 1, a.fastCapture, {
          producerId: '40000000-0000-4000-8000-000000000099',
        }),
        ...a.records.slice(1),
      ];
    if (fault === 'source')
      records = [
        a.make('decision', 1, a.fastCapture, { sourceRelease: 'b'.repeat(40) }),
        ...a.records.slice(1),
      ];
    if (fault === 'hand')
      records = [
        a.make('decision', 1, a.fastCapture, { handKey: 'b'.repeat(64) }),
        ...a.records.slice(1),
      ];
    if (fault === 'sequence')
      records = [a.make('decision', 8, a.fastCapture), ...a.records.slice(1)];
    if (fault === 'missing-fast') records = a.records.slice(1);
    if (fault === 'duplicate-fast')
      records = [a.fast, a.make('decision', 2, a.fastCapture), ...a.records.slice(1)];
    records = records.map((r) => (r === a.deep ? deep : r));
    const result = resolveKernelRetainedFastInput(records, deep);
    expect(result).toMatchObject({ status: 'unavailable' });
  });
  it('does not silently drop accepted coercion or unknown retirement', () => {
    const a = fixture();
    expect(
      kernelReconciledExecutionDisposition(
        a.make('execution', 2, {
          executionStatus: 'coerced',
          retirementReason: null,
          acceptedActions: [{}],
        })
      )
    ).toBe('unavailable');
    expect(
      kernelReconciledExecutionDisposition(
        a.make('execution', 2, {
          executionStatus: 'not_executed',
          retirementReason: 'unknown',
          acceptedActions: [],
          executedAction: null,
          executedAmount: null,
        })
      )
    ).toBe('unavailable');
    expect(
      kernelReconciledExecutionDisposition(
        a.make('execution', 2, {
          executionStatus: 'not_executed',
          retirementReason: 'second_look_replaced',
          acceptedActions: [],
          executedAction: null,
          executedAmount: null,
        })
      )
    ).toBe('retired');
  });
});

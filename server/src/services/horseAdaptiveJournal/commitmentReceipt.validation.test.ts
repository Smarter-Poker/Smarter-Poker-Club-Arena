import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseAdaptiveJournalWorker } from '../HorseAdaptiveJournalWorker.js';
import {
  emptyCommittedPotAudit,
  isCommittedPotAuditReceipt,
  type CommittedPotAuditReceipt,
} from './commitmentReceipt.js';

const states: CommittedPotAuditReceipt['status'][] = [
  'disabled',
  'unknown',
  'busy',
  'idle',
  'recorded',
  'pass_complete',
];
const malformedStatuses: Array<[string, unknown]> = [
  ['unknown array', ['unknown']],
  ['idle array', ['idle']],
  ['recorded array', ['recorded']],
  ['pass-complete array', ['pass_complete']],
  ['nested unknown array', [['unknown']]],
  ['boxed unknown string', Object('unknown')],
  ['object', {}],
  ['null', null],
  ['undefined', undefined],
  ['number', 0],
  ['boolean', false],
  ['empty string', ''],
  ['unrecognized string', 'complete'],
  ['multiple statuses', ['idle', 'unknown']],
];
const counters = [
  'scannedHands',
  'horseHands',
  'flaggedHorseHands',
  'unknownHorseHands',
  'handGaps',
] as const;
function receipt(status: CommittedPotAuditReceipt['status']): CommittedPotAuditReceipt {
  if (status === 'recorded' || status === 'pass_complete') {
    return {
      status,
      scannedHands: status === 'recorded' ? 256 : 5,
      horseHands: 8,
      flaggedHorseHands: 3,
      unknownHorseHands: 2,
      handGaps: 1,
    };
  }
  return emptyCommittedPotAudit(status);
}

class Child extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => {
    this.emit('exit', 1);
    return 1;
  });
}
let children: Child[];
let service: HorseAdaptiveJournalWorker;
beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  service = new HorseAdaptiveJournalWorker(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  // Existing supervisor retirement semantics, not a real Worker/provider claim.
  try {
    const stopped = service.stop();
    await vi.advanceTimersByTimeAsync(20001);
    await stopped;
    expect(service.status().phase).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
function begin(): Child {
  expect(service.start()).toBe(true);
  const child = children[0];
  child.emit('message', { type: 'READY' });
  return child;
}
function deliver(child: Child, commitment: unknown): void {
  child.emit('message', { type: 'CYCLE_STARTED' });
  // Real IPC cloning semantics for values, then the actual owner's listener.
  // This is still an injected child, not the compiled nested worker graph.
  child.emit(
    'message',
    structuredClone({
      type: 'CYCLE_COMPLETED',
      work: 'skipped',
      retention: 'skipped',
      commitment,
    })
  );
}

describe('committed audit receipt primitive contract', () => {
  it.each(states)('accepts valid primitive %s with its existing counter rules', (status) => {
    expect(isCommittedPotAuditReceipt(receipt(status))).toBe(true);
  });
  it.each(malformedStatuses)('rejects %s without string coercion', (_label, status) => {
    expect(isCommittedPotAuditReceipt({ ...emptyCommittedPotAudit('unknown'), status })).toBe(
      false
    );
  });
  it('does not call a caller-owned status conversion hook', () => {
    const toString = vi.fn(() => 'unknown');
    expect(
      isCommittedPotAuditReceipt({ ...emptyCommittedPotAudit('unknown'), status: { toString } })
    ).toBe(false);
    expect(toString).not.toHaveBeenCalled();
  });
  it.each(counters)('keeps %s strictly numeric instead of coercing arrays', (field) => {
    expect(isCommittedPotAuditReceipt({ ...receipt('pass_complete'), [field]: [1] })).toBe(false);
  });
  it.each([
    ['recorded short page', { ...receipt('recorded'), scannedHands: 255 }],
    ['complete full page', { ...receipt('pass_complete'), scannedHands: 256 }],
    ['unknown with counters', { ...receipt('unknown'), scannedHands: 1 }],
    ['more Horses than seats', { ...receipt('pass_complete'), horseHands: 51 }],
    ['more flags than Horses', { ...receipt('pass_complete'), flaggedHorseHands: 7 }],
    ['more gaps than hands', { ...receipt('pass_complete'), handGaps: 6 }],
  ])('retains %s refusal', (_label, value) => {
    expect(isCommittedPotAuditReceipt(value)).toBe(false);
  });
});

describe('actual supervisor commitment admission', () => {
  it.each(states)('consumes primitive %s without private payload leakage', (status) => {
    const child = begin();
    const value = receipt(status);
    deliver(child, { ...value, privateCards: ['private-card'], horseId: 'private-horse' });
    expect(service.status()).toMatchObject({
      phase: 'ready',
      cycles: 1,
      completed: 0,
      commitmentHandsScanned: value.scannedHands,
      commitmentHandsFlagged: value.flaggedHorseHands,
      commitmentHandsUnknown: value.unknownHorseHands,
      commitmentSourceGaps: value.handGaps,
      commitmentPasses: status === 'pass_complete' ? 1 : 0,
      lastCommitmentStatus: status,
      uncertain: status === 'unknown' ? 1 : 0,
    });
    expect(JSON.stringify(service.status())).not.toContain('private-');
    expect(child.terminate).not.toHaveBeenCalled();
  });
  it.each(malformedStatuses)(
    'retires the worker for %s before crediting a cycle',
    async (_label, status) => {
      const child = begin();
      deliver(child, { ...emptyCommittedPotAudit('unknown'), status });
      expect(service.status()).toMatchObject({
        phase: 'recovering',
        cycles: 0,
        completed: 0,
        commitmentHandsScanned: 0,
        commitmentHandsFlagged: 0,
        commitmentHandsUnknown: 0,
        commitmentPasses: 0,
        lastCommitmentStatus: null,
        uncertain: 0,
      });
      // Existing malformed-message failure path retires; it does not invent an
      // uncertainty counter for a receipt that never passed admission.
      await vi.advanceTimersByTimeAsync(0);
      expect(child.terminate).toHaveBeenCalledTimes(1);
    }
  );
  it('preserves a prior valid unknown diagnosis when a later status array is refused', () => {
    const child = begin();
    deliver(child, receipt('unknown'));
    deliver(child, { ...emptyCommittedPotAudit('unknown'), status: ['unknown'] });
    expect(service.status()).toMatchObject({
      phase: 'recovering',
      cycles: 1,
      uncertain: 1,
      lastCommitmentStatus: 'unknown',
      commitmentPasses: 0,
    });
  });
  it('refuses late valid completion from the malformed generation while stopping', async () => {
    const child = begin();
    deliver(child, { ...emptyCommittedPotAudit('unknown'), status: ['unknown'] });
    const stopped = service.stop();
    deliver(child, receipt('pass_complete'));
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(service.status()).toMatchObject({
      phase: 'stopped',
      cycles: 0,
      commitmentPasses: 0,
      lastCommitmentStatus: null,
    });
    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
  });
});

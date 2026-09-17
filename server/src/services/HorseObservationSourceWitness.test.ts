import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { prepareObservationSourceWitness as prepare } from './HorseObservationSourceWitness.js';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';

const snapshot = (): Extract<CommittedObservationSnapshot, { status: 'snapshot' }> => ({
  status: 'snapshot',
  version: 1,
  actorKey: 'a'.repeat(64),
  observations: [],
  rejected: {},
  source: {
    coverage: 'retained_committed_roster_rows',
    acceptance: 'atomic_hand_receipts',
    fromMs: 1000,
    throughMs: 2000,
    readAtMs: 3000,
    snapshotId: '100:102:101',
    hands: 2,
    sourceBytes: 42,
    sourceDigest: 'b'.repeat(64),
  },
});
describe('bounded original source witness', () => {
  it('replays exact bytes and preserves the read boundary without observations or private fields', () => {
    const s = snapshot();
    const r = prepare(s)!;
    expect(JSON.parse(r.payload)).toEqual([
      1,
      s.actorKey,
      1000,
      2000,
      3000,
      '100:102:101',
      2,
      42,
      s.source.sourceDigest,
      'retained_committed_roster_rows',
      'atomic_hand_receipts',
    ]);
    expect(r.digest).toBe(createHash('sha256').update(r.payload).digest('hex'));
    expect(prepare(JSON.parse(JSON.stringify(s)))).toEqual(r);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r).not.toHaveProperty('complete');
    Object.assign(s.source, { readAtMs: 3001 });
    expect(prepare(s)!.digest).not.toBe(r.digest);
  });
  it.each([
    ['fromMs', -1],
    ['throughMs', 1000],
    ['readAtMs', 1999],
    ['hands', 513],
    ['hands', 0.1],
    ['sourceBytes', 8388609],
    ['sourceDigest', 'bad'],
    ['snapshotId', '100:102:word'],
    ['snapshotId', '1:2:' + Array(5000).fill('1').join(',')],
    ['coverage', 'complete'],
    ['acceptance', 'history_only'],
  ])('refuses invalid or oversized %s metadata', (key, value) => {
    const s = snapshot();
    Object.assign(s.source, { [key]: value });
    expect(prepare(s)).toBeNull();
  });
  it('binds metadata before the caller mutates its source object', () => {
    const s = snapshot();
    const r = prepare(s)!;
    Object.assign(s.source, { snapshotId: '200:201:', hands: 0 });
    expect(JSON.parse(r.payload)[5]).toBe('100:102:101');
    expect(JSON.parse(r.payload)[6]).toBe(2);
  });
});

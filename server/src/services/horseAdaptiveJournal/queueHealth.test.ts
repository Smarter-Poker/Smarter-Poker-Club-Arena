import { describe, expect, it } from 'vitest';
import { parseJournalQueueHealth } from './queueHealth.js';
const now = 100000;
const snapshot = () => ({
  version: 1,
  status: 'snapshot',
  sampledAtMs: now,
  unfinished: 3,
  queued: 1,
  leased: 1,
  quarantined: 1,
  ready: 1,
  expiredLeases: 0,
  bufferedBytes: 400,
  oldestWorkAgeMs: 2000,
  maxAttempts: 4,
});
describe('public queue health allowlist', () => {
  it('keeps counts while removing every identity, payload and unrelated field', () => {
    const r = parseJournalQueueHealth(
      { ...snapshot(), payload: 'secret', batchKey: 'private', serviceKey: 'never' },
      now
    );
    expect(r).toEqual({
      status: 'snapshot',
      sampledAtMs: now,
      unfinished: 3,
      queued: 1,
      leased: 1,
      quarantined: 1,
      ready: 1,
      expiredLeases: 0,
      bufferedBytes: 400,
      oldestWorkAgeMs: 2000,
      maxAttempts: 4,
    });
    expect(Object.isFrozen(r)).toBe(true);
  });
  it.each([
    { unfinished: 257 },
    { bufferedBytes: 67108865 },
    { queued: 2 },
    { ready: 3 },
    { expiredLeases: 2 },
    { ready: 0, expiredLeases: 1 },
    { maxAttempts: 1000001 },
    { oldestWorkAgeMs: -1 },
    { sampledAtMs: now + 60001 },
    { sampledAtMs: now - 60001 },
    { quarantined: '1' },
    { version: 2 },
  ])('refuses inconsistent or stale health %j', (change) => {
    expect(parseJournalQueueHealth({ ...snapshot(), ...change }, now)).toEqual({
      status: 'unknown',
    });
  });
  it('preserves explicit budget refusal without treating it as an empty queue', () => {
    expect(
      parseJournalQueueHealth(
        { version: 1, status: 'unavailable', reason: 'queue_budget_exceeded' },
        now
      )
    ).toEqual({ status: 'unavailable', reason: 'queue_budget_exceeded' });
  });
  it('accepts a known empty sample and refuses impossible empty metadata', () => {
    const d = {
      ...snapshot(),
      unfinished: 0,
      queued: 0,
      leased: 0,
      quarantined: 0,
      ready: 0,
      bufferedBytes: 0,
      oldestWorkAgeMs: 0,
      maxAttempts: 0,
    };
    expect(parseJournalQueueHealth(d, now).status).toBe('snapshot');
    expect(parseJournalQueueHealth({ ...d, bufferedBytes: 1 }, now)).toEqual({ status: 'unknown' });
  });
});

import { describe, it, expect } from 'vitest';
import { parseCaptureQueueHealth as parse } from './captureHealth.js';
const now = 1789350000000;
const healthy = {
  version: 1,
  status: 'snapshot',
  sampledAtMs: now,
  unfinished: 3,
  queued: 1,
  leased: 1,
  gaps: 1,
  ready: 2,
  expiredLeases: 1,
  oldestWorkAgeMs: 1000,
  maxAttempts: 4,
};
describe('durable acquisition aggregate boundary', () => {
  it('retains explicit gaps, freezes counts and strips identities and arbitrary fields', () => {
    const r = parse({ ...healthy, actorId: 'private', payload: 'private' }, now);
    expect(r.status).toBe('snapshot');
    if (r.status !== 'snapshot') throw Error('expected snapshot');
    expect(r.gaps).toBe(1);
    expect(r.unfinished).toBe(3);
    expect(Object.isFrozen(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain('private');
  });
  it.each([
    { ...healthy, sampledAtMs: now - 60001 },
    { ...healthy, sampledAtMs: now + 60001 },
    { ...healthy, unfinished: 257 },
    { ...healthy, gaps: 0 },
    { ...healthy, ready: 3 },
    { ...healthy, expiredLeases: 2 },
    { ...healthy, maxAttempts: 1000001 },
    { ...healthy, unfinished: 0, queued: 0, leased: 0, gaps: 0, ready: 0, expiredLeases: 0 },
    null,
  ])('refuses stale, oversized and inconsistent counts %j', (data) => {
    expect(parse(data, now)).toEqual({ status: 'unknown' });
  });
  it('keeps overflow unavailable instead of returning zero work', () => {
    expect(
      parse({ version: 1, status: 'unavailable', reason: 'queue_budget_exceeded' }, now)
    ).toEqual({ status: 'unavailable', reason: 'queue_budget_exceeded' });
  });
});

import { test, expect } from 'vitest';
import { LifecycleDiagnostics } from './LifecycleDiagnostics.js';
test('bounded snapshots stay immutable and omit arbitrary payloads', () => {
  const journal = new LifecycleDiagnostics();
  for (let n = 0; n < 40; n++)
    journal.record('writer_pending', { attempt: n, payload: 'SECRET' } as any);
  const first = journal.snapshot();
  expect(first.records).toHaveLength(32);
  expect(first.droppedRecords).toBe(8);
  expect(JSON.stringify(first)).not.toContain('SECRET');
  expect(Object.isFrozen(first.records[0])).toBe(true);
  journal.record('stop_completed');
  expect(first.lastSequence).toBe(40);
  expect(new LifecycleDiagnostics().instanceId).not.toBe(first.instanceId);
});

import { describe, it, expect } from 'vitest';
import { selectCompletingDue, COMPLETING_DWELL_MS } from './completingDwell.js';

describe('selectCompletingDue', () => {
  it('never recovers a row on the pass that first sees it', () => {
    const { due, seenAt } = selectCompletingDue(['a'], new Map(), 1_000);

    expect(due).toEqual([]);
    expect(seenAt.get('a')).toBe(1_000);
  });

  it('recovers once the row has been COMPLETING for the whole five minutes', () => {
    const first = selectCompletingDue(['a'], new Map(), 0);
    const later = selectCompletingDue(['a'], first.seenAt, COMPLETING_DWELL_MS - 1);
    const due = selectCompletingDue(['a'], later.seenAt, COMPLETING_DWELL_MS);

    expect(later.due).toEqual([]);
    expect(due.due).toEqual(['a']);
  });

  it('forgets a row that left COMPLETING, so a later stall starts a fresh clock', () => {
    const first = selectCompletingDue(['a'], new Map(), 0);
    const gone = selectCompletingDue([], first.seenAt, 10_000);
    expect(gone.seenAt.has('a')).toBe(false);

    // The same tournament id can never be reused, but the same TABLE of ids
    // can: what matters is that a row seen again starts from now, not from a
    // timestamp left over from a completion that already succeeded.
    const again = selectCompletingDue(['a'], gone.seenAt, 20_000);
    expect(again.due).toEqual([]);
    expect(again.seenAt.get('a')).toBe(20_000);
  });

  it('keeps the first sighting rather than resetting it on every pass', () => {
    let seen = selectCompletingDue(['a'], new Map(), 0).seenAt;
    for (let t = 1; t < 10; t++) {
      seen = selectCompletingDue(['a'], seen, t * 30_000).seenAt;
    }
    expect(seen.get('a')).toBe(0);
  });

  it('is bounded by the live COMPLETING set, never by everything ever seen', () => {
    let seen = new Map<string, number>();
    for (let i = 0; i < 500; i++) {
      seen = selectCompletingDue([`t${i}`], seen, i).seenAt;
    }
    expect(seen.size).toBe(1);
  });

  it('counts a duplicated id once', () => {
    const { seenAt } = selectCompletingDue(['a', 'a'], new Map(), 0);
    expect(seenAt.size).toBe(1);
  });

  it('ignores empty ids rather than tracking a clock for nothing', () => {
    const { due, seenAt } = selectCompletingDue(['', 'a'], new Map(), 0);
    expect(due).toEqual([]);
    expect([...seenAt.keys()]).toEqual(['a']);
  });
});

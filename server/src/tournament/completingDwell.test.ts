import { describe, it, expect } from 'vitest';
import {
  selectCompletingDue,
  isCompletingWedged,
  COMPLETING_DWELL_MS,
  COMPLETING_WEDGED_MS,
} from './completingDwell.js';

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

  /**
   * A MANAGER THAT HAS HELD A FINISH FOR FIFTEEN MINUTES IS NOT FINISHING IT.
   *
   * The recovery skips any row a TournamentManager still holds. That is right
   * for the seconds a finish takes and was unbounded after that, so a wedged
   * manager held its row out of reach of the only thing that could rescue it.
   * Found live: a satellite with 23 entrants, 207 chips of pool, 448 hands,
   * one survivor, zero payout records, sixteen minutes in COMPLETING, and no
   * incident naming it - which is what proves nothing reached it.
   */
  it('does not call a row wedged before three times the dwell', () => {
    expect(isCompletingWedged(0, COMPLETING_WEDGED_MS - 1)).toBe(false);
    expect(isCompletingWedged(0, COMPLETING_DWELL_MS)).toBe(false);
  });

  it('calls it wedged at three times the dwell and after', () => {
    expect(isCompletingWedged(0, COMPLETING_WEDGED_MS)).toBe(true);
    expect(isCompletingWedged(0, COMPLETING_WEDGED_MS * 4)).toBe(true);
  });

  it('never calls a row it has not seen wedged', () => {
    // No first sighting means no clock. A row seen for the first time on this
    // pass must not have a manager torn off it.
    expect(isCompletingWedged(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('escalates strictly after the recovery becomes due, never before', () => {
    expect(COMPLETING_WEDGED_MS).toBeGreaterThan(COMPLETING_DWELL_MS);
  });
});

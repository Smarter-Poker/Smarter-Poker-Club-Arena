/**
 * The period math behind the rake snapshot.
 *
 * These are CALENDAR periods, not rolling ones. On the 3rd of a month, "this
 * month" is three days and "last 30 days" is thirty - they disagree by an order
 * of magnitude, and the union settles against the calendar. Every boundary is
 * UTC, because the daily rollups these figures come from are keyed on UTC days,
 * and an operator in UTC-7 asking for "today" late in their evening must not be
 * handed tomorrow's empty window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { periodToRange } from '../../src/services/ClubRakeSnapshotService';

/** A Thursday, mid-month, mid-quarter — nothing lands on a convenient edge. */
const NOW = new Date('2026-09-17T04:20:00.000Z');

function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('periodToRange', () => {
  it('day is the single UTC day that is running now', () => {
    at(NOW.toISOString());
    expect(periodToRange('today')).toEqual({ start: '2026-09-17', end: '2026-09-17' });
  });

  it('week is Monday-anchored, matching the union settlement week', () => {
    at(NOW.toISOString()); // Thursday
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-17' });
  });

  it('a Monday is its own week start, not the week before', () => {
    at('2026-09-14T00:00:01.000Z');
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-14' });
  });

  it('a Sunday belongs to the week that began six days earlier', () => {
    at('2026-09-20T23:59:00.000Z');
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
  });

  it('month runs from the first of the calendar month, not thirty days back', () => {
    at('2026-09-03T09:00:00.000Z');
    expect(periodToRange('month')).toEqual({ start: '2026-09-01', end: '2026-09-03' });
  });

  it('quarter starts at the quarter boundary', () => {
    at(NOW.toISOString()); // September is Q3
    expect(periodToRange('quarter')).toEqual({ start: '2026-07-01', end: '2026-09-17' });
    at('2026-01-05T00:00:00.000Z');
    expect(periodToRange('quarter')).toEqual({ start: '2026-01-01', end: '2026-01-05' });
  });

  it('year starts on January 1 of the year in progress', () => {
    at(NOW.toISOString());
    expect(periodToRange('year')).toEqual({ start: '2026-01-01', end: '2026-09-17' });
  });

  it('late-evening local time still resolves against the UTC day', () => {
    // 2026-09-17 21:30 in UTC-7 is 2026-09-18 04:30 UTC. The rollup calls that
    // the 18th, so the snapshot must too, or the tile reads empty and the
    // operator concludes the club produced nothing.
    at('2026-09-18T04:30:00.000Z');
    expect(periodToRange('today')).toEqual({ start: '2026-09-18', end: '2026-09-18' });
  });

  it('custom passes both edges through', () => {
    at(NOW.toISOString());
    expect(periodToRange('custom', { start: '2026-03-01', end: '2026-03-31' })).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
    });
  });

  it('custom with the edges the wrong way round is ordered, not rejected', () => {
    // Two date inputs make this trivially reachable, and a start after its end
    // is an empty window that reads as "you produced nothing".
    at(NOW.toISOString());
    expect(periodToRange('custom', { start: '2026-03-31', end: '2026-03-01' })).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
    });
  });

  it('custom with nothing supplied falls back to today rather than 1970', () => {
    at(NOW.toISOString());
    expect(periodToRange('custom')).toEqual({ start: '2026-09-17', end: '2026-09-17' });
  });
});

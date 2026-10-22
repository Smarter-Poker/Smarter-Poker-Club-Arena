/**
 * The period math behind the rake snapshot.
 *
 * These are CALENDAR periods, not rolling ones. On the 3rd of a month, "this
 * month" is three days and "last 30 days" is thirty - they disagree by an order
 * of magnitude, and the union settles against the calendar.
 *
 * UPDATED 2026-10-22 (Dan): every boundary is an America/Chicago calendar day,
 * daylight saving included, because Club Data and Union Data now bucket every
 * figure by the Chicago day (20261022103651, 20261022120121). Until then these
 * were UTC days, and an operator in Chicago asking for "today" at 8 PM was
 * handed tomorrow's nearly empty window. These tests pinned that UTC rule;
 * they now pin the Chicago one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { periodToRange } from '../../src/services/ClubRakeSnapshotService';
import { addCalendarDays, chicagoClock, chicagoDay } from '../../src/lib/clubDataDay';

/** A Thursday afternoon in Chicago, mid-month, mid-quarter. */
const NOW = new Date('2026-09-17T19:20:00.000Z');

function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('periodToRange', () => {
  it('day is the single Chicago day that is running now', () => {
    at(NOW.toISOString());
    expect(periodToRange('today')).toEqual({ start: '2026-09-17', end: '2026-09-17' });
  });

  it('yesterday is the Chicago day before', () => {
    at(NOW.toISOString());
    expect(periodToRange('yesterday')).toEqual({ start: '2026-09-16', end: '2026-09-16' });
  });

  it('week is Monday-anchored, matching the union settlement week', () => {
    at(NOW.toISOString()); // Thursday
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-17' });
  });

  it('a Monday is its own week start, not the week before', () => {
    at('2026-09-14T05:00:01.000Z'); // 00:00:01 Monday in Chicago (CDT)
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-14' });
  });

  it('a Sunday belongs to the week that began six days earlier', () => {
    at('2026-09-21T04:59:00.000Z'); // 23:59 Sunday in Chicago
    expect(periodToRange('week')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
  });

  it('month runs from the first of the calendar month, not thirty days back', () => {
    at('2026-09-03T15:00:00.000Z');
    expect(periodToRange('month')).toEqual({ start: '2026-09-01', end: '2026-09-03' });
  });

  it('quarter starts at the quarter boundary', () => {
    at(NOW.toISOString()); // September is Q3
    expect(periodToRange('quarter')).toEqual({ start: '2026-07-01', end: '2026-09-17' });
    at('2026-01-05T12:00:00.000Z');
    expect(periodToRange('quarter')).toEqual({ start: '2026-01-01', end: '2026-01-05' });
  });

  it('year starts on January 1 of the year in progress', () => {
    at(NOW.toISOString());
    expect(periodToRange('year')).toEqual({ start: '2026-01-01', end: '2026-09-17' });
  });

  it('a Chicago evening is still that day, not the next UTC day', () => {
    // 2026-09-17 21:30 in Chicago is 2026-09-18 02:30 UTC. The figures are
    // keyed on the Chicago day, so "today" is the 17th.
    at('2026-09-18T02:30:00.000Z');
    expect(periodToRange('today')).toEqual({ start: '2026-09-17', end: '2026-09-17' });
  });

  it('the year rolls over at Chicago midnight, not UTC midnight', () => {
    at('2027-01-01T03:00:00.000Z'); // 21:00 on December 31 in Chicago (CST)
    expect(periodToRange('year')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    at('2027-01-01T06:00:00.000Z'); // 00:00 on January 1 in Chicago
    expect(periodToRange('year')).toEqual({ start: '2027-01-01', end: '2027-01-01' });
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

describe('the Club Data clock', () => {
  it('follows daylight saving: midnight is 05:00 UTC in summer and 06:00 UTC in winter', () => {
    expect(chicagoDay(new Date('2026-10-22T04:59:59Z'))).toBe('2026-10-21');
    expect(chicagoDay(new Date('2026-10-22T05:00:00Z'))).toBe('2026-10-22');
    expect(chicagoDay(new Date('2026-12-02T05:59:59Z'))).toBe('2026-12-01');
    expect(chicagoDay(new Date('2026-12-02T06:00:00Z'))).toBe('2026-12-02');
  });

  it('the DST change days are whole calendar days', () => {
    // 2026-11-01 is 25 hours long in Chicago; 2026-03-08 is 23.
    expect(chicagoDay(new Date('2026-11-01T05:00:00Z'))).toBe('2026-11-01');
    expect(chicagoDay(new Date('2026-11-02T05:59:59Z'))).toBe('2026-11-01');
    expect(chicagoDay(new Date('2026-03-08T05:59:59Z'))).toBe('2026-03-07');
    expect(chicagoDay(new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-08');
    expect(chicagoDay(new Date('2026-03-09T04:59:59Z'))).toBe('2026-03-08');
  });

  it('steps calendar days without drifting across a month or a DST change', () => {
    expect(addCalendarDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('prints the Chicago clock, and nothing for a malformed time', () => {
    expect(chicagoClock('2026-10-22T17:05:00Z')).toBe('12:05');
    expect(chicagoClock('not a time')).toBe('');
  });
});

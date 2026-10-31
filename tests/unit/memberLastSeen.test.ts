import { describe, expect, it } from 'vitest';
import { lastSeenIsWithinADay, memberLastSeenLabel } from '../../src/utils/memberLastSeen';

// Dan, 2026-10-31: "IF ITS 'SEEN TODAY' CHANGE IT TO SEEN AN HOUR AGO, OR 2
// HOURS AGO. OR TO THE MINUTE IF THE DATA IS AVAILABLE".
const NOW = Date.parse('2026-10-31T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('player list last seen', () => {
  it('never says "Seen Today"', () => {
    for (const age of [0, 30_000, MIN, 5 * MIN, HOUR, 3 * HOUR, DAY - 1]) {
      expect(memberLastSeenLabel(ago(age), NOW)).not.toBe('Seen Today');
    }
  });

  it('counts minutes inside the first hour', () => {
    expect(memberLastSeenLabel(ago(20_000), NOW)).toBe('Seen Just Now');
    expect(memberLastSeenLabel(ago(MIN), NOW)).toBe('Seen 1 Min Ago');
    expect(memberLastSeenLabel(ago(14 * MIN + 59_000), NOW)).toBe('Seen 14 Mins Ago');
    expect(memberLastSeenLabel(ago(59 * MIN), NOW)).toBe('Seen 59 Mins Ago');
  });

  it('counts hours inside the first day', () => {
    expect(memberLastSeenLabel(ago(HOUR), NOW)).toBe('Seen 1 Hour Ago');
    expect(memberLastSeenLabel(ago(2 * HOUR + 40 * MIN), NOW)).toBe('Seen 2 Hours Ago');
    expect(memberLastSeenLabel(ago(DAY - 1), NOW)).toBe('Seen 23 Hours Ago');
  });

  it('keeps the compact age past a day', () => {
    expect(memberLastSeenLabel(ago(DAY), NOW)).toBe('Seen 1d Ago');
    expect(memberLastSeenLabel(ago(8 * DAY + HOUR), NOW)).toBe('Seen 8d Ago');
    expect(memberLastSeenLabel(ago(65 * DAY), NOW)).toBe('Seen 2mo Ago');
    expect(memberLastSeenLabel(ago(400 * DAY), NOW)).toBe('Seen 1y Ago');
  });

  it('a future or unreadable time never shows a wrong age', () => {
    expect(memberLastSeenLabel(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('Seen Just Now');
    expect(memberLastSeenLabel('not a time', NOW)).toBe('');
  });

  it('only rows seen inside the last day need the minute clock', () => {
    expect(lastSeenIsWithinADay(ago(3 * HOUR), NOW)).toBe(true);
    expect(lastSeenIsWithinADay(ago(DAY), NOW)).toBe(false);
    expect(lastSeenIsWithinADay('', NOW)).toBe(false);
  });
});

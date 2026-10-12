import { afterEach, expect, it, vi } from 'vitest';
import { isoDate, lastDaysRange } from '../../src/services/ClubRosterService';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([
  ['2026-03-08T00:05:00Z', 7, '2026-03-02', '2026-03-08'],
  ['2026-11-01T00:05:00Z', 7, '2026-10-26', '2026-11-01'],
  ['2026-01-01T00:01:00Z', 30, '2025-12-03', '2026-01-01'],
  ['2026-10-11T23:59:59Z', 1, '2026-10-11', '2026-10-11'],
])(
  'uses inclusive UTC calendar days at %s across midnight, DST and year boundaries',
  (now, days, from, to) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    expect(lastDaysRange(days)).toEqual({ from, to });
  }
);
it('formats the UTC day rather than the supplied offset calendar day', () => {
  expect(isoDate(new Date('2026-01-01T23:30:00-08:00'))).toBe('2026-01-02');
  expect(isoDate(new Date('2026-01-01T00:30:00+14:00'))).toBe('2025-12-31');
});

// Hosted workers often use UTC. Model a browser calendar on either side of UTC
// independently so this boundary stays enforced in that environment too.
it.each([
  ['2026-03-08T00:05:00Z', -480, '2026-03-08'],
  ['2026-10-11T23:59:59Z', 840, '2026-10-11'],
])(
  'ignores the local calendar at offset %s/%s when computing the submitted UTC day',
  (now, offsetMinutes, day) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const localCalendar = new Date(Date.parse(now) + offsetMinutes * 60_000);
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(localCalendar.getUTCFullYear());
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(localCalendar.getUTCMonth());
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(localCalendar.getUTCDate());
    expect(lastDaysRange(1)).toEqual({ from: day, to: day });
  }
);

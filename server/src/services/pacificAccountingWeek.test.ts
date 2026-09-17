import { describe, expect, it } from 'vitest';
import { pacificAccountingWeek } from './pacificAccountingWeek.js';

describe('Pacific accounting calendar', () => {
  it.each([
    ['2026-09-14T06:59:59.999999Z', '2026-09-07', '2026-09-13'],
    ['2026-09-14T07:00:00.000000Z', '2026-09-14', '2026-09-20'],
    ['2026-03-09T06:59:59.999999Z', '2026-03-02', '2026-03-08'],
    ['2026-03-09T07:00:00.000000Z', '2026-03-09', '2026-03-15'],
    ['2026-11-02T07:59:59.999999Z', '2026-10-26', '2026-11-01'],
    ['2026-11-02T08:00:00.000000Z', '2026-11-02', '2026-11-08'],
    ['2027-01-01T04:00:00Z', '2026-12-28', '2027-01-03'],
  ])('places %s in %s through %s', (instant, start, end) => {
    expect(pacificAccountingWeek(instant)).toEqual({ periodStart: start, periodEnd: end });
  });
  it('refuses an invalid earning timestamp', () => {
    expect(() => pacificAccountingWeek('unknown')).toThrow('Invalid accounting earning timestamp');
  });
});

import { describe, expect, it } from 'vitest';
import { memberRangeSearch, readMemberRangeSearch } from '../../src/utils/memberRangeLink';
import { RANGE_OVERALL, lastDaysRange } from '../../src/services/ClubRosterService';

describe('the record range travels to Player Statistics', () => {
  it('writes the record range into the link', () => {
    expect(memberRangeSearch('overall', RANGE_OVERALL)).toBe('range=overall');
    expect(memberRangeSearch('week', lastDaysRange(7))).toBe('range=week');
    expect(memberRangeSearch('custom', { from: '2026-09-01', to: '2026-09-30' })).toBe(
      'range=custom&from=2026-09-01&to=2026-09-30'
    );
    expect(memberRangeSearch('custom', RANGE_OVERALL)).toBe('range=overall');
  });

  it('reads a carried range back and validates it', () => {
    const read = (q: string) => readMemberRangeSearch(new URLSearchParams(q));
    expect(read('')).toEqual({ mode: 'overall', range: RANGE_OVERALL });
    expect(read('range=week')).toEqual({ mode: 'week', range: lastDaysRange(7) });
    expect(read('range=day')).toEqual({ mode: 'day', range: lastDaysRange(1) });
    expect(read('range=month')).toEqual({ mode: 'month', range: lastDaysRange(30) });
    expect(read('range=custom&from=2026-09-01&to=2026-09-30')).toEqual({
      mode: 'custom',
      range: { from: '2026-09-01', to: '2026-09-30' },
    });
    for (const bad of [
      'range=year',
      'range=custom',
      'range=custom&from=2026-09-30&to=2026-09-01',
      'range=custom&from=2026-02-30&to=2026-03-01',
      'range=custom&from=yesterday&to=2026-03-01',
    ]) {
      expect(read(bad)).toEqual({ mode: 'overall', range: RANGE_OVERALL });
    }
  });
});

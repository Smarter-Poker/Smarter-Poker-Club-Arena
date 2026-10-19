import {
  RANGE_OVERALL,
  isoDate,
  lastDaysRange,
  type MemberRange,
} from '../services/ClubRosterService';

/**
 * THE RANGE TRAVELS WITH THE LINK. The Player Record opens Player Statistics
 * on the window the record is showing, so "7 Days" on one screen is "7 Days"
 * on the next instead of silently becoming "Month". The record writes
 * `?range=` (and `from` / `to` for a confirmed custom window); Statistics reads
 * it back, validates it, and falls back to Overall.
 */
export type MemberRangeMode = 'overall' | 'day' | 'week' | 'month' | 'custom';

export const MEMBER_RANGE_DAYS: Record<'day' | 'week' | 'month', number> = {
  day: 1,
  week: 7,
  month: 30,
};

const MODES: ReadonlySet<string> = new Set(['overall', 'day', 'week', 'month', 'custom']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/** The query string (without "?") that carries a range to Player Statistics. */
export function memberRangeSearch(mode: MemberRangeMode, range: MemberRange): string {
  const params = new URLSearchParams({ range: mode });
  if (mode === 'custom') {
    if (!validDate(range.from) || !validDate(range.to)) return 'range=overall';
    params.set('from', range.from);
    params.set('to', range.to);
  }
  return params.toString();
}

/** Reads a carried range. Anything missing or malformed opens on Overall. */
export function readMemberRangeSearch(params: URLSearchParams): {
  mode: MemberRangeMode;
  range: MemberRange;
} {
  const mode = params.get('range');
  if (!mode || !MODES.has(mode) || mode === 'overall') {
    return { mode: 'overall', range: RANGE_OVERALL };
  }
  if (mode === 'custom') {
    const from = params.get('from');
    const to = params.get('to');
    if (validDate(from) && validDate(to) && from <= to) {
      return { mode: 'custom', range: { from, to } };
    }
    return { mode: 'overall', range: RANGE_OVERALL };
  }
  const days = MEMBER_RANGE_DAYS[mode as 'day' | 'week' | 'month'];
  return { mode: mode as MemberRangeMode, range: lastDaysRange(days) };
}

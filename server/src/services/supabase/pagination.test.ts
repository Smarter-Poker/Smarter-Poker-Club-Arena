/**
 * fetchAllRows — the guard against silent PostgREST truncation.
 *
 * PostgREST caps every response at db-max-rows (1,000 on this project) without
 * erroring. HorseFleetManager read all open seats with a bare .select(), got the
 * first 1,000 of 1,428, and treated the 428 it could not see as EMPTY SEATS —
 * 18,744 duplicate-key rejections in three hours, ~150,000 a day.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import { fetchAllRows, POSTGREST_PAGE } from './pagination.js';

/** A PostgREST double that enforces the server-side row cap. */
function fakeTable(total: number, cap = POSTGREST_PAGE) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const ranges: [number, number][] = [];
  const make = () => ({
    range: async (from: number, to: number) => {
      ranges.push([from, to]);
      const end = Math.min(to, from + cap - 1);
      return { data: rows.slice(from, end + 1), error: null };
    },
  });
  return { make, ranges };
}

beforeEach(() => mockReportError.mockReset());

describe('fetchAllRows', () => {
  it('returns EVERY row when the result exceeds one PostgREST page', async () => {
    // The exact production shape: 1,428 open seats against a 1,000 cap.
    const t = fakeTable(1428);
    const rows = await fetchAllRows<{ id: number }>(t.make, { label: 'test' });

    expect(rows).toHaveLength(1428);
    expect(rows[0].id).toBe(0);
    expect(rows[1427].id).toBe(1427);
    // A bare .select() would have stopped here, silently.
    expect(rows.length).toBeGreaterThan(POSTGREST_PAGE);
    expect(t.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('stops on a short page instead of paging forever', async () => {
    const t = fakeTable(150);
    const rows = await fetchAllRows<{ id: number }>(t.make, { label: 'test' });
    expect(rows).toHaveLength(150);
    expect(t.ranges).toHaveLength(1);
  });

  it('asks once more when the last page is exactly full', async () => {
    // 1,000 rows is indistinguishable from "1,000 and more" without a second
    // request. Guessing here is the whole bug.
    const t = fakeTable(1000);
    const rows = await fetchAllRows<{ id: number }>(t.make, { label: 'test' });
    expect(rows).toHaveLength(1000);
    expect(t.ranges).toHaveLength(2);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('handles an empty table', async () => {
    const t = fakeTable(0);
    expect(await fetchAllRows(t.make, { label: 'test' })).toEqual([]);
  });

  it('REPORTS rather than silently truncating at the row ceiling', async () => {
    const t = fakeTable(10_000);
    const rows = await fetchAllRows<{ id: number }>(t.make, {
      label: 'test',
      maxRows: 2000,
    });
    expect(rows).toHaveLength(2000);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(String(mockReportError.mock.calls[0][1])).toContain('row_ceiling');
  });

  it('reports a page error and returns the partial result rather than pretending', async () => {
    let call = 0;
    const make = () => ({
      range: async (from: number) => {
        call++;
        if (call === 2) return { data: null, error: { message: 'fetch failed' } };
        return {
          data: Array.from({ length: POSTGREST_PAGE }, (_, i) => ({ id: from + i })),
          error: null,
        };
      },
    });
    const rows = await fetchAllRows<{ id: number }>(make, { label: 'test' });
    expect(rows).toHaveLength(POSTGREST_PAGE);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(String(mockReportError.mock.calls[0][1])).toContain('page_failed');
  });

  it('never asks for a page larger than the server will return', async () => {
    const t = fakeTable(10);
    await fetchAllRows(t.make, { label: 'test', pageSize: 50_000 });
    expect(t.ranges[0]).toEqual([0, POSTGREST_PAGE - 1]);
  });
});

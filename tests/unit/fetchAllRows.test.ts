/**
 * The helper that makes "all of them" mean all of them.
 * See src/utils/fetchAllRows.ts for why the ceilings it replaces were
 * dangerous: a club roster export stopping at 5,000 hands an owner a file
 * that is silently incomplete.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchAllRows } from '../../src/utils/fetchAllRows';

/** A fake table of `n` rows that answers .range(from, to) like PostgREST. */
const table = (n: number, pageSize = 1000) => {
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  const calls: Array<[number, number]> = [];
  const query = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };
  return { query, calls, pageSize };
};

describe('fetchAllRows reads every row, not the first page', () => {
  it('returns all rows across several pages', async () => {
    const t = table(2500);
    const out = await fetchAllRows(t.query, { pageSize: 1000 });
    expect(out).toHaveLength(2500);
    // 3 pages: 1000, 1000, 500 — the short page ends it.
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('stops after ONE request when the first page is already short', async () => {
    const t = table(12);
    const out = await fetchAllRows(t.query, { pageSize: 1000 });
    expect(out).toHaveLength(12);
    expect(t.calls).toHaveLength(1);
  });

  it('handles an exact multiple of the page size without losing the last page', async () => {
    // The off-by-one that would drop rows: 2000 rows is two FULL pages, so a
    // third request is required to learn there is no more.
    const t = table(2000);
    const out = await fetchAllRows(t.query, { pageSize: 1000 });
    expect(out).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it('treats an empty table as an empty answer, not an error', async () => {
    const t = table(0);
    await expect(fetchAllRows(t.query, { pageSize: 1000 })).resolves.toEqual([]);
  });

  it('accepts null data with no error as "no rows"', async () => {
    const q = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(fetchAllRows(q, { pageSize: 10 })).resolves.toEqual([]);
  });
});

describe('a partial answer is never returned as if it were complete', () => {
  it('throws on the first failed page instead of handing back half a roster', async () => {
    const q = vi
      .fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 10 }, (_, i) => ({ i })), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    await expect(fetchAllRows(q, { pageSize: 10, label: 'roster' })).rejects.toThrow(
      /roster: page 1 failed - connection reset/
    );
  });

  it('refuses to loop forever if pages never come back short', async () => {
    // A query that always returns a full page is a bug in the query; looping
    // on it would hang the caller silently.
    const q = vi.fn().mockResolvedValue({ data: [{ i: 0 }, { i: 1 }], error: null });
    await expect(fetchAllRows(q, { pageSize: 2, maxPages: 5 })).rejects.toThrow(
      /still returning full pages after 5/
    );
    expect(q).toHaveBeenCalledTimes(5);
  });

  it('rejects a nonsense page size rather than spinning', async () => {
    const q = vi.fn();
    await expect(fetchAllRows(q, { pageSize: 0 })).rejects.toThrow(/pageSize must be at least 1/);
    expect(q).not.toHaveBeenCalled();
  });
});

/**
 * fetchAllRows — the guard against silent PostgREST truncation.
 *
 * PostgREST caps every response at db-max-rows (1,000 here) without erroring.
 * HorseFleetManager read all open seats with a bare .select(), got the first
 * 1,000 of 1,428, and treated the 428 it could not see as EMPTY SEATS — 18,744
 * duplicate-key rejections in three hours, ~150,000 a day.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import { fetchAllRows, POSTGREST_PAGE } from './pagination.js';

interface Row extends Record<string, unknown> {
  id: string;
}

/** ids sort lexicographically, so pad them — real ids are uuids. */
const mkId = (n: number) => `id-${String(n).padStart(6, '0')}`;

/**
 * A PostgREST double that enforces the server-side row cap and supports keyset
 * (`id > cursor`). `mutate` runs between pages, so a test can delete or insert
 * underneath the pagination exactly as a live table does.
 */
function fakeTable(total: number, opts: { cap?: number; mutate?: (rows: Row[]) => void } = {}) {
  const cap = opts.cap ?? POSTGREST_PAGE;
  let rows: Row[] = Array.from({ length: total }, (_, i) => ({ id: mkId(i) }));
  const cursors: (string | null)[] = [];
  let page = 0;
  const query = (cursor: string | null, want: number) => {
    if (page++ > 0 && opts.mutate) opts.mutate(rows);
    cursors.push(cursor);
    const start = cursor === null ? 0 : rows.findIndex((r) => r.id > cursor);
    const from = start < 0 ? rows.length : start;
    return Promise.resolve({
      data: rows.slice(from, from + Math.min(want, cap)),
      error: null,
    });
  };
  return {
    query,
    cursors,
    remove: (id: string) => {
      rows = rows.filter((r) => r.id !== id);
    },
    get rows() {
      return rows;
    },
  };
}

beforeEach(() => mockReportError.mockReset());

describe('fetchAllRows', () => {
  it('returns EVERY row when the result exceeds one PostgREST page', async () => {
    // The exact production shape: 1,428 open seats against a 1,000 cap.
    const t = fakeTable(1428);
    const { rows, complete } = await fetchAllRows<Row>(t.query, { label: 'test' });

    expect(complete).toBe(true);
    expect(rows).toHaveLength(1428);
    expect(rows[0].id).toBe(mkId(0));
    expect(rows[1427].id).toBe(mkId(1427));
    // A bare .select() would have stopped at 1,000, silently.
    expect(rows.length).toBeGreaterThan(POSTGREST_PAGE);
    expect(t.cursors).toEqual([null, mkId(999)]);
  });

  it('does not SKIP a row when one is deleted between pages', async () => {
    // This is what OFFSET paging got wrong. With `.range()`, deleting any row
    // from page 1 shifts everything down and OFFSET 1000 starts past a row that
    // is still there — so it is never returned, and the seeder reads that seat
    // as empty. Seats empty constantly in a live room.
    const t = fakeTable(1428, {
      mutate: (rows) => {
        const i = rows.findIndex((r) => r.id === mkId(10));
        if (i >= 0) rows.splice(i, 1); // a player leaves mid-pass
      },
    });

    const { rows, complete } = await fetchAllRows<Row>(t.query, { label: 'test' });

    expect(complete).toBe(true);
    // The row that MATTERS is the one at the page boundary. Under OFFSET it
    // vanished; under keyset it is present.
    expect(rows.some((r) => r.id === mkId(1000))).toBe(true);
    expect(rows.some((r) => r.id === mkId(1001))).toBe(true);
    // 1,428: page 1 legitimately returned the row that was deleted afterwards —
    // it existed when we read it. Nothing was skipped and nothing repeated.
    expect(rows).toHaveLength(1428);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1428);
    // Every id from the boundary onward is contiguous — the OFFSET bug showed
    // up here as a hole.
    const tail = rows.slice(1000).map((r) => r.id);
    expect(tail[0]).toBe(mkId(1000));
    expect(tail[tail.length - 1]).toBe(mkId(1427));
  });

  it('does not DUPLICATE a row when one is inserted behind the cursor', async () => {
    const t = fakeTable(1428, {
      mutate: (rows) => rows.unshift({ id: 'id-000000-a' }),
    });

    const { rows } = await fetchAllRows<Row>(t.query, { label: 'test' });

    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('stops on a short page instead of paging forever', async () => {
    const t = fakeTable(150);
    const { rows, complete } = await fetchAllRows<Row>(t.query, { label: 'test' });
    expect(rows).toHaveLength(150);
    expect(complete).toBe(true);
    expect(t.cursors).toHaveLength(1);
  });

  it('asks once more when the last page is exactly full', async () => {
    // 1,000 rows is indistinguishable from "1,000 and more" without a second
    // request. Guessing here is the whole bug.
    const t = fakeTable(1000);
    const { rows, complete } = await fetchAllRows<Row>(t.query, { label: 'test' });
    expect(rows).toHaveLength(1000);
    expect(complete).toBe(true);
    expect(t.cursors).toHaveLength(2);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('handles an empty table', async () => {
    const t = fakeTable(0);
    const { rows, complete } = await fetchAllRows<Row>(t.query, { label: 'test' });
    expect(rows).toEqual([]);
    expect(complete).toBe(true);
  });

  it('reports AND flags incomplete at the row ceiling', async () => {
    const t = fakeTable(10_000);
    const { rows, complete } = await fetchAllRows<Row>(t.query, {
      label: 'test',
      maxRows: 2000,
    });
    expect(rows).toHaveLength(2000); // exactly the ceiling, not the next page boundary
    expect(complete).toBe(false);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(String(mockReportError.mock.calls[0][1])).toContain('row_ceiling');
  });

  it('flags incomplete on a page error instead of passing off a partial result', async () => {
    // The first version returned a bare T[] here — a short array
    // indistinguishable from a complete one, behind a Sentry event nobody
    // blocks on. That re-armed the exact failure it was written to fix.
    let call = 0;
    const query = (cursor: string | null, want: number) => {
      call++;
      if (call === 2) return Promise.resolve({ data: null, error: { message: 'fetch failed' } });
      return Promise.resolve({
        data: Array.from({ length: want }, (_, i) => ({ id: mkId(i) })),
        error: null,
      });
    };
    const { rows, complete } = await fetchAllRows<Row>(query, { label: 'test' });
    expect(rows).toHaveLength(POSTGREST_PAGE);
    expect(complete).toBe(false);
    expect(String(mockReportError.mock.calls[0][1])).toContain('page_failed');
  });

  it('never asks for a page larger than the server will return', async () => {
    const sizes: number[] = [];
    await fetchAllRows<Row>(
      (_c, want) => {
        sizes.push(want);
        return Promise.resolve({ data: [], error: null });
      },
      { label: 'test', pageSize: 50_000 }
    );
    expect(sizes[0]).toBe(POSTGREST_PAGE);
  });

  it('cannot spin forever on a nonsense page size', async () => {
    const sizes: number[] = [];
    const { complete } = await fetchAllRows<Row>(
      (_c, want) => {
        sizes.push(want);
        return Promise.resolve({ data: [], error: null });
      },
      { label: 'test', pageSize: 0 }
    );
    // pageSize 0 previously meant `offset += 0` and a page that is never short:
    // an infinite loop hammering PostgREST.
    expect(sizes[0]).toBeGreaterThanOrEqual(1);
    expect(complete).toBe(true);
  });

  it('refuses to guess when the select omitted the cursor column', async () => {
    // Paging cannot advance without it, and silently looping the first page
    // forever would be far worse than stopping.
    const { rows, complete } = await fetchAllRows(
      (_c, want) =>
        Promise.resolve({ data: Array.from({ length: want }, () => ({})), error: null }),
      { label: 'test' }
    );
    expect(complete).toBe(false);
    expect(rows).toHaveLength(POSTGREST_PAGE);
    expect(String(mockReportError.mock.calls[0][1])).toContain('missing_cursor_key');
  });
});

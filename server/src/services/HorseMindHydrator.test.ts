import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ from: vi.fn(), observe: vi.fn(), report: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { from: mock.from } }));
vi.mock('../engine/HorseMind.js', () => ({ HorseMind: { observe: mock.observe } }));
vi.mock('./errorReporter.js', () => ({ reportError: mock.report }));
import { hydrateHorseMind } from './HorseMindHydrator.js';

const NOW = Date.UTC(2026, 8, 12, 18),
  stamp = '2026-09-12T17:59:59.123456+00:00';
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const row = (n: number, created_at = stamp) => ({
  id: uuid(n),
  created_at,
  actions: [{ id: n, action: 'call' }],
});
type Row = ReturnType<typeof row>;
type Query = {
  select?: string;
  since?: string;
  through?: string;
  orders: string[];
  limit?: number;
  cursor?: string;
};
let queries: Query[];
function source(
  rows: Row[],
  override?: (query: Query, index: number) => { data: unknown; error: unknown }
) {
  mock.from.mockImplementation((table: string) => {
    expect(table).toBe('hand_history');
    const query: Query = { orders: [] };
    queries.push(query);
    const builder = {
      select(value: string) {
        query.select = value;
        return builder;
      },
      gt(column: string, value: string) {
        expect(column).toBe('created_at');
        query.since = value;
        return builder;
      },
      lte(column: string, value: string) {
        expect(column).toBe('created_at');
        query.through = value;
        return builder;
      },
      order(column: string, options: unknown) {
        expect(options).toEqual({ ascending: false });
        query.orders.push(column);
        return builder;
      },
      limit(value: number) {
        query.limit = value;
        return builder;
      },
      or(value: string) {
        query.cursor = value;
        return builder;
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        if (override) return Promise.resolve(override(query, queries.length)).then(resolve, reject);
        let selected = rows.filter(
          (r) =>
            Date.parse(r.created_at) > Date.parse(query.since!) &&
            Date.parse(r.created_at) <= Date.parse(query.through!)
        );
        // Exact timestamp strings in these transport fixtures, with independent
        // tuple ordering. Native PostgreSQL tests cover actual timestamp parsing.
        selected.sort(
          (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
        );
        if (query.cursor) {
          const match =
            /^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.([a-f0-9-]+)\)$/.exec(
              query.cursor
            );
          expect(match).not.toBeNull();
          expect(match![1]).toBe(match![2]);
          selected = selected.filter(
            (r) => r.created_at < match![1] || (r.created_at === match![1] && r.id < match![3])
          );
        }
        return Promise.resolve({ data: selected.slice(0, query.limit), error: null }).then(
          resolve,
          reject
        );
      },
    };
    return builder;
  });
}
beforeEach(() => {
  queries = [];
  mock.from.mockReset();
  mock.observe.mockReset();
  mock.report.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('restart history pages retain every tied hand identity', () => {
  it('replays all 2,500 same-timestamp hands once in ascending order', async () => {
    source(Array.from({ length: 2500 }, (_, i) => row(i)));
    await hydrateHorseMind();
    expect(queries).toHaveLength(3);
    expect(mock.observe).toHaveBeenCalledTimes(2500);
    expect(mock.observe.mock.calls.map(([actions]) => actions[0].id)).toEqual(
      Array.from({ length: 2500 }, (_, i) => i)
    );
    expect(queries[0]).toMatchObject({
      select: 'id, actions, created_at',
      orders: ['created_at', 'id'],
      limit: 1000,
      since: '2026-09-09T18:00:00.000Z',
      through: '2026-09-12T18:00:00.000Z',
    });
    expect(queries[1].cursor).toBe(
      `created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${uuid(1500)})`
    );
    expect(mock.report).not.toHaveBeenCalled();
  });
  it('retains distinct microsecond timestamps that Date.parse collapses', async () => {
    const older = '2026-09-12T17:59:59.123455+00:00';
    expect(Date.parse(older)).toBe(Date.parse(stamp));
    source([...Array.from({ length: 1000 }, (_, i) => row(i, stamp)), row(2000, older)]);
    await hydrateHorseMind();
    expect(mock.observe).toHaveBeenCalledTimes(1001);
    expect(mock.observe.mock.calls[0][0][0].id).toBe(2000);
    expect(queries[1].cursor).toContain(stamp);
  });
  it('retains the exact 12,000-hand ceiling while selecting the newest ties', async () => {
    source(Array.from({ length: 13000 }, (_, i) => row(i)));
    await hydrateHorseMind();
    expect(queries).toHaveLength(12);
    expect(mock.observe).toHaveBeenCalledTimes(12000);
    expect(mock.observe.mock.calls[0][0][0].id).toBe(1000);
    expect(mock.observe.mock.calls.at(-1)![0][0].id).toBe(12999);
  });
  it('preserves an exact valid flush cutoff and clamps old, future or malformed cutoffs', async () => {
    const cutoff = '2026-09-12T17:59:58.123456+00:00';
    source([]);
    await hydrateHorseMind(cutoff);
    expect(queries[0].since).toBe(cutoff);
    for (const invalid of [
      '2026-09-01T00:00:00.000Z',
      '2026-09-13T00:00:00.000Z',
      'bad),id.gt.fake',
      '',
    ]) {
      queries = [];
      await hydrateHorseMind(invalid);
      expect(queries[0].since).toBe('2026-09-09T18:00:00.000Z');
    }
  });
  it('compares timezone-equivalent cutoffs by time instead of lexicographic text', async () => {
    source([]);
    const cutoff = '2026-09-09T13:00:00.123456-05:00';
    await hydrateHorseMind(cutoff);
    expect(queries[0].since).toBe(cutoff);
  });
  it.each([
    null,
    { ...row(1), id: 'bad),id.gt.fake' },
    { ...row(1), created_at: 'bad),id.gt.fake' },
    { ...row(1), created_at: '2026-09-13T00:00:00Z' },
    { ...row(1), created_at: '2026-09-08T00:00:00Z' },
  ])('rejects malformed or out-of-window pages before observation %#', async (bad) => {
    source([], () => ({ data: [bad], error: null }));
    await hydrateHorseMind();
    expect(mock.observe).not.toHaveBeenCalled();
    expect(mock.report).toHaveBeenCalledWith(expect.any(Error), 'HorseMindHydrator.page');
  });
  it('rejects oversized or non-array responses without widening the query', async () => {
    for (const data of [Array.from({ length: 1001 }, (_, i) => row(1001 - i)), {}]) {
      source([], () => ({ data, error: null }));
      await hydrateHorseMind();
    }
    expect(mock.observe).not.toHaveBeenCalled();
    expect(mock.report).toHaveBeenCalledTimes(2);
  });
  it('rejects repeated or out-of-order pages rather than learning duplicates', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => row(1000 - i));
    source([], (_q, index) => ({ data: index === 1 ? first : [first.at(-1)], error: null }));
    await hydrateHorseMind();
    expect(mock.observe).toHaveBeenCalledTimes(1000);
    expect(mock.report).toHaveBeenCalledWith(expect.any(Error), 'HorseMindHydrator.page');
    mock.observe.mockClear();
    source([], () => ({ data: [row(1), row(2)], error: null }));
    await hydrateHorseMind();
    expect(mock.observe).not.toHaveBeenCalled();
  });
  it('replays only previously validated pages after a database error', async () => {
    source([], (_q, index) =>
      index === 1
        ? { data: Array.from({ length: 1000 }, (_, i) => row(1000 - i)), error: null }
        : { data: null, error: { message: 'read unavailable' } }
    );
    await hydrateHorseMind();
    expect(mock.observe).toHaveBeenCalledTimes(1000);
    expect(mock.report).toHaveBeenCalledWith(expect.any(Error), 'HorseMindHydrator.query');
  });
  it('keeps a malformed action payload or consumer failure isolated to its hand', async () => {
    source([{ ...row(2), actions: [] }, row(1), row(0)]);
    mock.observe.mockImplementationOnce(() => {
      throw Error('unusable old actions');
    });
    await hydrateHorseMind();
    expect(mock.observe).toHaveBeenCalledTimes(2);
  });
});

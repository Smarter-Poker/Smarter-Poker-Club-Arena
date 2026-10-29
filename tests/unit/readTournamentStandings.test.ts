import { describe, expect, it, vi, beforeEach } from 'vitest';
const fx = vi.hoisted(() => ({
  rows: [] as any[],
  requests: [] as number[],
  fail: -1,
  removeAfterFirst: false,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let offset = 0;
      let cursor: string | null = null;
      let limit = 1000;
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        in: () => q,
        gt: (_key: string, value: string) => {
          cursor = value;
          return q;
        },
        limit: (value: number) => {
          limit = value;
          return q;
        },
        range: (start: number) => {
          offset = start;
          return q;
        },
        then: (resolve: any) => {
          if (cursor !== null) offset = fx.rows.findIndex((row) => row.id > cursor);
          if (offset < 0) offset = fx.rows.length;
          fx.requests.push(offset);
          const page = fx.rows.slice(offset, offset + Math.min(limit, 1000));
          const count = cursor === null ? fx.rows.length : fx.rows.length - offset;
          if (fx.removeAfterFirst && fx.requests.length === 1) fx.rows = fx.rows.slice(1);
          return Promise.resolve(
            offset === fx.fail
              ? { data: null, error: { message: 'refused' }, count: null }
              : { data: page, error: null, count }
          ).then(resolve);
        },
      };
      return q;
    },
  },
}));
import { readTournamentStandings } from '../../src/services/readTournamentStandings';
beforeEach(() => {
  fx.requests = [];
  fx.fail = -1;
  fx.rows = [];
  fx.removeAfterFirst = false;
});
describe('standings snapshots include every table', () => {
  it.each([0, 1000, 9001])('finishes a stable field of %i rows', async (count) => {
    fx.rows = Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(8, '0') }));
    const result = await readTournamentStandings('mtt', 'id');
    expect(result.data).toEqual(fx.rows);
    expect(result.count).toBe(count);
    expect(fx.requests).toHaveLength(Math.floor(count / 1000) + 1);
  });
  it('refuses a full page without its cursor instead of publishing a partial field', async () => {
    fx.rows = Array.from({ length: 1000 }, () => ({ chips: 10 }));
    const result = await readTournamentStandings('mtt', 'chips');
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(fx.requests).toHaveLength(1);
  });
  it('reads past the API cap before returning a rankable field', async () => {
    fx.rows = Array.from({ length: 1501 }, (_, i) => ({
      id: String(i).padStart(8, '0'),
      chips: i,
    }));
    const result = await readTournamentStandings('mtt', 'id, chips');
    expect(result.data).toHaveLength(1501);
    expect(fx.requests).toEqual([0, 1000]);
    expect(result.count).toBe(1501);
  });
  it('does not skip the still-active last entrant when an earlier entrant busts between pages', async () => {
    fx.rows = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(8, '0'),
      chips: i,
    }));
    fx.removeAfterFirst = true;
    const result = await readTournamentStandings('mtt', 'id, chips', true);
    expect(result.error).toBeNull();
    expect(result.data?.some((row) => row.id === '00001000')).toBe(true);
  });
  it('never publishes a partial field when a later page fails', async () => {
    fx.rows = Array.from({ length: 1501 }, (_, i) => ({ id: String(i).padStart(8, '0') }));
    fx.fail = 1000;
    const result = await readTournamentStandings('mtt', 'id');
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ message: 'refused' });
  });
});

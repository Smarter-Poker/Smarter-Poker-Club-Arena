import { describe, expect, it, vi, beforeEach } from 'vitest';
const fx = vi.hoisted(() => ({ rows: [] as any[], requests: [] as number[], fail: -1 }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let offset = 0;
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        in: () => q,
        range: (start: number) => {
          offset = start;
          return q;
        },
        then: (resolve: any) => {
          fx.requests.push(offset);
          return Promise.resolve(
            offset === fx.fail
              ? { data: null, error: { message: 'refused' }, count: null }
              : { data: fx.rows.slice(offset, offset + 1000), error: null, count: fx.rows.length }
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
});
describe('standings snapshots include every table', () => {
  it('reads past the API cap before returning a rankable field', async () => {
    fx.rows = Array.from({ length: 1501 }, (_, i) => ({ id: String(i), chips: i }));
    const result = await readTournamentStandings('mtt', 'id, chips');
    expect(result.data).toHaveLength(1501);
    expect(fx.requests).toEqual([0, 1000]);
    expect(result.count).toBe(1501);
  });
  it('never publishes a partial field when a later page fails', async () => {
    fx.rows = Array.from({ length: 1501 }, (_, i) => ({ id: String(i) }));
    fx.fail = 1000;
    const result = await readTournamentStandings('mtt', 'id');
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ message: 'refused' });
  });
});

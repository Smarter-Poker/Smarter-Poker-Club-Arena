import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ fn: string; args: unknown; order: string[]; range: [number, number] }> = [];
let pages: Array<{ data: unknown[] | null; error: unknown }> = [];

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      const call = { fn, args, order: [] as string[], range: [0, 0] as [number, number] };
      calls.push(call);
      const builder: any = {
        order: (column: string) => {
          call.order.push(column);
          return builder;
        },
        range: (from: number, to: number) => {
          call.range = [from, to];
          return Promise.resolve(pages.shift() ?? { data: [], error: null });
        },
      };
      return builder;
    },
  },
}));

import { readUnionDirectory, UNION_DIRECTORY_PAGE } from '../../src/services/unionDirectory';

const rows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ club_id: 'c', user_id: `u${offset + i}` }));

beforeEach(() => {
  calls.length = 0;
  pages = [];
});

describe('the union roster is read past the API row cap (sweep 2026-10-17)', () => {
  it('reads every page until a short one, in a total order', async () => {
    pages = [
      { data: rows(UNION_DIRECTORY_PAGE), error: null },
      { data: rows(3, UNION_DIRECTORY_PAGE), error: null },
    ];
    const result = await readUnionDirectory<{ user_id: string }>('union-1');
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(UNION_DIRECTORY_PAGE + 3);
    expect(calls.map((c) => c.range)).toEqual([
      [0, UNION_DIRECTORY_PAGE - 1],
      [UNION_DIRECTORY_PAGE, 2 * UNION_DIRECTORY_PAGE - 1],
    ]);
    for (const c of calls) {
      expect(c.fn).toBe('fn_union_player_directory');
      expect(c.args).toEqual({ p_union_id: 'union-1' });
      expect(c.order).toEqual(['club_id', 'user_id']);
    }
  });

  it('fails the whole read when a later page fails, never a partial roster', async () => {
    const boom = { message: 'timeout' };
    pages = [
      { data: rows(UNION_DIRECTORY_PAGE), error: null },
      { data: null, error: boom },
    ];
    const result = await readUnionDirectory('union-1');
    expect(result).toEqual({ data: null, error: boom });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { supabase } from '../services/supabase.js';

afterEach(() => vi.restoreAllMocks());

function fixture(failLaterPage = false) {
  // window-ok: identical top prizes fill a REST page; the other distinct rungs follow it.
  const rows = Array.from({ length: 1003 }, (_, i) => ({
    id: String(i + 1).padStart(8, '0'),
    amount_cents: i < 1000 ? 10000 : [5000, 2500, 1000][i - 1000],
  }));
  const cursors: Array<string | null> = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
    expect(relation).toBe('tournament_bounty_chests');
    let cursor: string | null = null;
    let limit = 1000;
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: (n: number) => {
        limit = Math.min(n, 1000);
        return query;
      },
      gt: (_key: string, value: string) => {
        cursor = value;
        return query;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        cursors.push(cursor);
        return Promise.resolve(
          failLaterPage && cursor !== null
            ? { data: null, error: new Error('page unavailable') }
            : {
                data: rows.filter((row) => cursor === null || row.id > cursor).slice(0, limit),
                error: null,
              }
        ).then(resolve, reject);
      },
    };
    return query;
  }) as never);
  const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, args: unknown) => {
    expect(name).toBe('fn_mystery_bounty_inventory');
    expect(args).toEqual({ p_tournament_id: 'chest-rank-event' });
    return failLaterPage
      ? { data: null, error: new Error('inventory unavailable') }
      : {
          data: {
            tiers: [...new Set(rows.map((row) => row.amount_cents))].map((amount_cents) => ({
              amount_cents,
            })),
          },
          error: null,
        };
  }) as never);
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: 'chest-rank-event',
  });
  return { manager, cursors, rpc };
}

describe('mystery chest rank uses the complete distinct inventory', () => {
  it('does not call the fourth distinct prize a top-three prize after duplicate top rows', async () => {
    const { manager, cursors, rpc } = fixture();
    expect(await manager.chestPrizeRank(1000)).toBe(4);
    expect(cursors).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('leaves a partial inventory unknown instead of announcing a guessed rank', async () => {
    const { manager } = fixture(true);
    expect(await manager.chestPrizeRank(1000)).toBeUndefined();
  });
});

it.each([
  null,
  {},
  { tiers: null },
  { tiers: [null] },
  { tiers: [{ amount_cents: null }] },
  { tiers: [{ amount_cents: '10000' }] },
  { tiers: [{ amount_cents: 100.5 }] },
  { tiers: [{ amount_cents: 0 }] },
])('does not rank malformed aggregate %j', async (data) => {
  const { manager, rpc } = fixture();
  rpc.mockResolvedValueOnce({ data, error: null } as never);
  expect(await manager.chestPrizeRank(1000)).toBeUndefined();
});
it('keeps an empty inventory unknown', async () => {
  const { manager, rpc } = fixture();
  rpc.mockResolvedValueOnce({ data: { tiers: [] }, error: null } as never);
  expect(await manager.chestPrizeRank(1000)).toBeUndefined();
});
it('ranks equal amounts in different tiers as the same prize', async () => {
  const { manager, rpc } = fixture();
  rpc.mockResolvedValueOnce({
    data: {
      tiers: [
        { amount_cents: 10000 },
        { amount_cents: 10000 },
        { amount_cents: 2500 },
        { amount_cents: 1000 },
      ],
    },
    error: null,
  } as never);
  expect(await manager.chestPrizeRank(2500)).toBe(2);
});

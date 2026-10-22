/**
 * The cross-table archive reads its page by the player's own index (2026-10-22).
 *
 * The ordered containment read timed out under RLS for any player with fewer
 * retained hands than the page asked for: Postgres walked the global
 * hand_number index and filtered the whole table. The archive now asks
 * fn_player_hand_history_page_ids for the page's ids and resolves them through
 * hand_history by id. These pins hold the client to that shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HAND_HISTORY_PAGE_IDS_RPC,
  handHistoryService,
} from '../../src/services/HandHistoryService';

const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; calls: Array<[string, ...any[]]> }>,
  history: [] as any[],
  historyError: null as any,
  rpc: vi.fn(),
  report: vi.fn(),
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => state.report(...args),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => state.rpc(...args),
    from: (table: string) => {
      const read = { table, calls: [] as Array<[string, ...any[]]> };
      state.reads.push(read);
      const query: any = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'range', 'in', 'contains', 'or'])
        query[method] = (...args: any[]) => {
          read.calls.push([method, ...args]);
          return query;
        };
      query.then = (done: (value: any) => void) => {
        const inCall = read.calls.find((call) => call[0] === 'in');
        const data = inCall
          ? state.history.filter((row) => inCall[2].includes(row.id))
          : state.history;
        return Promise.resolve({ data, error: state.historyError }).then(done);
      };
      return query;
    },
  },
}));

beforeEach(() => {
  state.reads.length = 0;
  state.history = [];
  state.historyError = null;
  state.report.mockClear();
  state.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  vi.spyOn(handHistoryService as any, 'mapPlayerHandRows').mockImplementation(
    async (rows: any[]) => rows
  );
});

describe('the archive page is read by the player index', () => {
  it('asks the page RPC and returns the hands in the order it gave', async () => {
    state.rpc.mockResolvedValue({
      data: [
        { id: 'c', hand_number: 30 },
        { id: 'a', hand_number: 10 },
      ],
      error: null,
    });
    // Storage order differs from play order; the RPC's order wins.
    state.history = [
      { id: 'a', hand_number: 10 },
      { id: 'c', hand_number: 30 },
    ];
    const result = await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      offset: 50,
      throwOnError: true,
    });
    expect(state.rpc).toHaveBeenCalledWith(HAND_HISTORY_PAGE_IDS_RPC, {
      p_user_id: 'viewer',
      p_limit: 25,
      p_offset: 50,
    });
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0].table).toBe('hand_history');
    expect(state.reads[0].calls).toContainEqual(['in', 'id', ['c', 'a']]);
    // No ordered containment scan is sent for the archive.
    expect(state.reads[0].calls.some((call) => call[0] === 'contains')).toBe(false);
    expect(state.reads[0].calls.some((call) => call[0] === 'order')).toBe(false);
    expect(result.map((row: any) => row.id)).toEqual(['c', 'a']);
  });

  it('an empty history is an empty page, with no table read at all', async () => {
    const result = await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      throwOnError: true,
    });
    expect(result).toEqual([]);
    expect(state.reads).toHaveLength(0);
  });

  it('a failed page read is a failure, never an empty history, when the caller asks', async () => {
    const failure = { message: 'page unavailable' };
    state.rpc.mockResolvedValue({ data: null, error: failure });
    await expect(
      handHistoryService.getPlayerHands('viewer', 25, { indexedArchive: true, throwOnError: true })
    ).rejects.toEqual(failure);
    await expect(
      handHistoryService.getPlayerHands('viewer', 25, { indexedArchive: true })
    ).resolves.toEqual([]);
    expect(state.report).toHaveBeenCalledWith(
      failure,
      'HandHistoryService.getPlayerHands_archive_page'
    );
  });

  it('preserves default and live-table reads and the club RPC unchanged', async () => {
    await handHistoryService.getPlayerHands('viewer', 25);
    expect(state.reads).toHaveLength(1);
    expect(state.rpc).not.toHaveBeenCalled();
    state.reads.length = 0;
    await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      tableId: 'table',
    });
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0].calls).toContainEqual(['eq', 'table_id', 'table']);
    expect(state.rpc).not.toHaveBeenCalled();
    state.reads.length = 0;
    await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      clubId: 'club',
      offset: 25,
    });
    expect(state.reads).toHaveLength(0);
    expect(state.rpc).toHaveBeenCalledWith('ca_own_hand_history_by_club', {
      p_club_id: 'club',
      p_table_id: null,
      p_limit: 25,
      p_offset: 25,
    });
  });

  it('the installed page function stays security invoker and never walks the table for a small history', () => {
    const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
    const sql = readFileSync(
      join(dir, '20261022191846_a_players_own_hand_history_reads_by_its_own_index.sql'),
      'utf8'
    );
    expect(sql).toMatch(/FUNCTION public\.fn_player_hand_history_page_ids\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/FROM public\.ca_hand_player_idx i/);
    expect(sql).toMatch(/LIMIT v_cap \+ 1/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handHistoryService } from '../../src/services/HandHistoryService';

type Row = { id: string; hand_number: number | null; owned?: boolean };
const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; calls: Array<[string, ...any[]]> }>,
  seeds: [] as any[],
  retained: [] as any[],
  history: [] as any[],
  seedError: null as any,
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
      for (const method of [
        'select',
        'eq',
        'order',
        'limit',
        'range',
        'in',
        'contains',
        'or',
        'is',
        'not',
      ])
        query[method] = (...args: any[]) => {
          read.calls.push([method, ...args]);
          return query;
        };
      query.then = (done: (value: any) => void) => {
        const selected = read.calls.find((call) => call[0] === 'select')?.[1];
        if (table === 'ca_hand_player_idx' || table === 'ca_hand_player_stat') {
          const range = read.calls.find((call) => call[0] === 'range')!;
          return Promise.resolve({
            data: state.seeds.slice(range[1], range[2] + 1),
            error: state.seedError,
          }).then(done);
        }
        if (selected === 'id, hand_number') {
          const ids = read.calls.find((call) => call[0] === 'in')![2];
          return Promise.resolve({
            data: state.retained.filter((row) => ids.includes(row.id) && row.owned !== false),
            error: state.seedError,
          }).then(done);
        }
        let data = state.history.filter((row) => row.owned !== false);
        const bound = read.calls.find((call) => call[0] === 'or')?.[1];
        if (bound) {
          const floor = Number(bound.match(/gte\.(-?\d+)/)[1]);
          data = data.filter((row) => row.hand_number === null || row.hand_number >= floor);
        }
        data = [...data].sort((a, b) =>
          a.hand_number === null ? -1 : b.hand_number === null ? 1 : b.hand_number - a.hand_number
        );
        const range = read.calls.find((call) => call[0] === 'range');
        const limit = read.calls.find((call) => call[0] === 'limit')?.[1];
        data = range ? data.slice(range[1], range[2] + 1) : data.slice(0, limit);
        return Promise.resolve({ data, error: state.historyError }).then(done);
      };
      return query;
    },
  },
}));

function setupSeeds(numbers: number[]) {
  state.seeds = numbers.map((_, i) => ({ hand_id: `seed-${i}` }));
  state.retained = numbers.map((hand_number, i) => ({ id: `seed-${i}`, hand_number }));
}
function finalRead() {
  return state.reads.find((read) =>
    read.calls.some(
      (call) => call[0] === 'select' && call[1] !== 'hand_id' && call[1] !== 'id, hand_number'
    )
  )!;
}
beforeEach(() => {
  state.reads.length = 0;
  state.seeds = [];
  state.retained = [];
  state.history = [];
  state.seedError = null;
  state.historyError = null;
  state.report.mockClear();
  state.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  vi.spyOn(handHistoryService as any, 'mapPlayerHandRows').mockImplementation(
    async (rows: Row[]) => rows
  );
});

describe('Archive-only indexed bounds', () => {
  it('uses distinct retained owned seeds but lets the authoritative query include unindexed newer hands and null legacy rows', async () => {
    setupSeeds([10, 30]); // Created order differs from play order.
    state.history = [
      { id: 'unindexed', hand_number: 40 },
      { id: 'older', hand_number: 1 },
      { id: 'seed-0', hand_number: 10 },
      { id: 'seed-1', hand_number: 30 },
      { id: 'legacy', hand_number: null },
    ];
    const result = await handHistoryService.getPlayerHands('viewer', 2, {
      indexedArchive: true,
      throwOnError: true,
    });
    expect(state.reads[0].table).toBe('ca_hand_player_idx');
    expect(state.reads[0].calls).toContainEqual(['eq', 'user_id', 'viewer']);
    expect(state.reads[0].calls).toContainEqual(['range', 0, 1]);
    expect(state.reads[1].calls).toContainEqual([
      'contains',
      'players',
      JSON.stringify([{ userId: 'viewer' }]),
    ]);
    expect(finalRead().calls).toContainEqual(['or', 'hand_number.gte.10,hand_number.is.null']);
    expect(finalRead().calls).toContainEqual(['order', 'hand_number', { ascending: false }]);
    expect(result.map((row) => row.id)).toEqual(['legacy', 'unindexed']);
  });
  it('qualifies offset plus limit and keeps the original offset range', async () => {
    setupSeeds([10, 20, 30, 40]);
    state.history = state.retained.concat({ id: 'new', hand_number: 50 });
    const result = await handHistoryService.getPlayerHands('viewer', 2, {
      indexedArchive: true,
      offset: 2,
    });
    expect(state.reads[0].calls).toContainEqual(['range', 0, 3]);
    expect(finalRead().calls).toContainEqual(['or', 'hand_number.gte.10,hand_number.is.null']);
    expect(finalRead().calls).toContainEqual(['range', 2, 3]);
    expect(result.map((row) => row.id)).toEqual(['seed-2', 'seed-1']);
  });
  it('retains the original query for pruned, null, duplicate-number or unexpected seeds', async () => {
    for (const reason of ['pruned', 'null', 'duplicate-number', 'unexpected-id']) {
      state.reads.length = 0;
      setupSeeds([10, 20]);
      if (reason === 'pruned') state.retained.pop();
      if (reason === 'null') state.retained[1].hand_number = null;
      if (reason === 'duplicate-number') state.retained[1].hand_number = 10;
      if (reason === 'unexpected-id') state.retained[1].id = 'not-requested';
      await handHistoryService.getPlayerHands('viewer', 2, { indexedArchive: true });
      expect(finalRead().calls.some((call) => call[0] === 'or')).toBe(false);
    }
  });
  it('falls back on an unavailable seed read and exposes the original strict query failure', async () => {
    state.seedError = { message: 'Index unavailable' };
    state.historyError = { message: 'Archive unavailable' };
    await expect(
      handHistoryService.getPlayerHands('viewer', 2, { indexedArchive: true, throwOnError: true })
    ).rejects.toEqual(state.historyError);
    expect(state.report).toHaveBeenCalledWith(
      state.seedError,
      'HandHistoryService.archive_seed_index'
    );
  });
  it('qualifies deep pages in bounded chunks without imposing a product paging cap', async () => {
    setupSeeds(Array.from({ length: 1025 }, (_, index) => 10000 - index));
    state.history = state.retained;
    const result = await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      offset: 1000,
    });
    const indexedReads = state.reads.filter((read) => read.table === 'ca_hand_player_idx');
    expect(indexedReads).toHaveLength(2);
    expect(indexedReads[0].calls).toContainEqual(['range', 0, 999]);
    expect(indexedReads[1].calls).toContainEqual(['range', 1000, 1024]);
    const retainedReads = state.reads.filter((read) =>
      read.calls.some((call) => call[0] === 'select' && call[1] === 'id, hand_number')
    );
    expect(
      retainedReads.map((read) => read.calls.find((call) => call[0] === 'in')![2].length)
    ).toEqual([1000, 25]);
    expect(finalRead().calls).toContainEqual(['or', 'hand_number.gte.8976,hand_number.is.null']);
    expect(finalRead().calls).toContainEqual(['range', 1000, 1024]);
    expect(result).toHaveLength(25);
  });
  it('preserves default and live-table reads without indexing and the club RPC unchanged', async () => {
    await handHistoryService.getPlayerHands('viewer', 25);
    expect(state.reads).toHaveLength(1);
    state.reads.length = 0;
    await handHistoryService.getPlayerHands('viewer', 25, {
      indexedArchive: true,
      tableId: 'table',
    });
    expect(state.reads).toHaveLength(1);
    expect(finalRead().calls).toContainEqual(['eq', 'table_id', 'table']);
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
  it('anchors the page with seeds of the same game mode and filters before pagination', async () => {
    setupSeeds([10, 30]);
    await handHistoryService.getPlayerHands('viewer', 2, {
      indexedArchive: true,
      gameMode: 'cash',
      offset: 0,
    });
    expect(state.reads[0].table).toBe('ca_hand_player_stat');
    expect(state.reads[0].calls).toContainEqual(['eq', 'is_cash', true]);
    expect(finalRead().calls).toContainEqual(['is', 'tournament_id', null]);
    expect(finalRead().calls.findIndex((call) => call[0] === 'is')).toBeLessThan(
      finalRead().calls.findIndex((call) => call[0] === 'limit')
    );
    state.reads.length = 0;
    await handHistoryService.getPlayerHands('viewer', 2, { gameMode: 'tournament', offset: 4 });
    expect(finalRead().calls).toContainEqual(['not', 'tournament_id', 'is', null]);
    expect(finalRead().calls).toContainEqual(['range', 4, 5]);
  });
});
